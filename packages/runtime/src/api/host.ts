/**
 * 运行时 API 宿主：桌面 sidecar（stdio.ts）与浏览器开发模式（vite.ts）共用的一份后端。
 *
 * 一个宿主服务多个窗口：每次调用带 `ws`（窗口编号，桌面端 = 窗口 label，dev = "main"），每个窗口一个槽位
 * {文库 Workspace, 会话进程表}。事件经 emit(ws, event) 交给传输层，传输层只推给那个窗口。
 *
 * 设置（最近文库、上次文库、自动快照开关）存在 Tauri app_config_dir/settings.json；
 * settingsFile = null 时只在内存（dev 模式不碰用户的桌面设置）。库根只由宿主的调用方给：桌面是 Rust（对话框、
 * 打开入口、最近列表，规范化后再传），dev 是本机开发者——前端永远不能自报库外路径。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyEntryAt, createDirAt, entryInfoAt, moveEntryAt, renameEntryAt, revealEntryAt, trashEntryAt } from "../lib/file-ops.mjs";
import { folderAppData } from "../lib/folder-paths.mjs";
import { ensureOpenfileHome } from "../lib/openfile-home.mjs";
import { isLibraryRoot, listSessionArchives, readSessionArchive, writeSessionArchive } from "../lib/session-archive.mjs";
import { spawn } from "node:child_process";
import { AGENT_CLIS, resolveEntryBin } from "../lib/agent-registry.mjs";
import { registryEntry } from "@openfile/protocol/executor-registry";
import { ProcessTable } from "./processes.ts";
import { Workspace, httpError, type WorkspaceEvent } from "./workspace.ts";

interface HostOptions {
  /** settings.json 的位置；null = 只在内存 */
  settingsFile: string | null;
  emit: (ws: string, e: WorkspaceEvent) => void;
  /** 本运行时的 `openfile` 入口（cli.ts 或打包的 cli.mjs）：会话注入的 MCP 与导出对话都用它拉起 */
  cliEntry: string;
  /** 应用数据目录：不在文库里的会话档案（默认 folderAppData()） */
  appData?: string;
}

interface RecentLibrary {
  root: string;
  name: string;
  exists: boolean;
}

const MAX_RECENTS = 8;

/** Tauri app_config_dir 的各平台落点 */
export function appConfigDir(): string {
  const id = "com.wingsofsky.openfile";
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", id);
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), id);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), id);
}

type Params = Record<string, unknown>;

/**
 * ACP 预设里的原生命令（如 `grok agent stdio` 的 grok）：裸名字正好是登记表某条的 PATH 候选名时，按登记表的解析顺序找
 * （环境变量覆盖 → PATH → 发现规则的位置）。不是登记表里的名字给 null，走通用解析。
 * 不读打开的文件夹里的任何配置：文件夹可能是别人的仓库，不能由它决定点开对话时启动哪个程序。
 */
export function knownCommand(cmd: string): string | null {
  if (!cmd || /[\\/]/.test(cmd)) return null;
  const lower = cmd.toLowerCase();
  const cli = (AGENT_CLIS as Array<{ id: string; binNames: string[] }>).find((c) => c.binNames.some((n) => n.toLowerCase() === lower));
  if (!cli) return null;
  return resolveEntryBin(registryEntry(cli.id)) ?? null;
}

const str = (p: Params, k: string): string => {
  if (typeof p[k] !== "string") throw httpError(400, `缺少 ${k}`);
  return p[k] as string;
};
const optStr = (p: Params, k: string): string | undefined => {
  if (p[k] === undefined || p[k] === null) return undefined;
  return str(p, k);
};
const optNum = (p: Params, k: string): number | undefined => {
  if (p[k] === undefined || p[k] === null) return undefined;
  const n = Number(p[k]);
  if (!Number.isFinite(n)) throw httpError(400, `${k} 不是数字`);
  return n;
};

interface Slot {
  ws: Workspace | null;
  procs: ProcessTable;
}

export class Host {
  private slots = new Map<string, Slot>();
  private memory: Record<string, unknown> = {};

  readonly opts: HostOptions;

  constructor(opts: HostOptions) {
    this.opts = opts;
  }

  /* ---------------- 设置 ---------------- */

  private readSettings(): Record<string, unknown> {
    if (!this.opts.settingsFile) return this.memory;
    try {
      const v = JSON.parse(fs.readFileSync(this.opts.settingsFile, "utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  private writeSettings(v: Record<string, unknown>): void {
    if (!this.opts.settingsFile) {
      this.memory = v;
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.opts.settingsFile), { recursive: true });
      fs.writeFileSync(this.opts.settingsFile, JSON.stringify(v, null, 2));
    } catch (e) {
      console.error(`[openfile] 设置写入失败: ${(e as Error).message}`);
    }
  }

  autoSnapshot(): boolean {
    return this.readSettings().autoSnapshot !== false;
  }

  setAutoSnapshot(enabled: boolean): void {
    this.writeSettings({ ...this.readSettings(), autoSnapshot: enabled });
  }

  recents(): RecentLibrary[] {
    const list = this.readSettings().recents;
    return (Array.isArray(list) ? list : [])
      .filter((x): x is string => typeof x === "string")
      .map((s) => {
        const root = s.replace(/^\\\\\?\\(?!UNC\\)/, "");
        let exists = false;
        try {
          exists = fs.statSync(root).isDirectory();
        } catch {
          /* 不在了 */
        }
        return { root, name: path.basename(root) || s, exists };
      });
  }

  /** 进最近列表；主窗口的还记成「上次的文库」（启动时恢复它）——别的窗口开的库不顶替主窗口的 */
  private persistLibrary(root: string, last: boolean): void {
    const v = this.readSettings();
    const recents = this.recents().map((r) => r.root).filter((r) => r !== root);
    recents.unshift(root);
    this.writeSettings({ ...v, ...(last ? { library: root } : {}), recents: recents.slice(0, MAX_RECENTS) });
  }

  /** 上次打开的文库（还在才给） */
  persistedLibrary(): string | null {
    const lib = this.readSettings().library;
    if (typeof lib !== "string") return null;
    try {
      return fs.statSync(lib).isDirectory() ? lib : null;
    } catch {
      return null;
    }
  }

  /* ---------------- 槽位 ---------------- */

  private slot(ws: string): Slot {
    let s = this.slots.get(ws);
    if (!s) {
      s = { ws: null, procs: new ProcessTable((e) => this.opts.emit(ws, e)) };
      this.slots.set(ws, s);
    }
    return s;
  }

  procs(ws: string): ProcessTable {
    return this.slot(ws).procs;
  }

  workspace(ws: string): Workspace {
    const w = this.slots.get(ws)?.ws;
    if (!w) throw httpError(409, "尚未选择文库");
    return w;
  }

  /** 该窗口当前文库根；没开文库时为 null */
  rootOf(ws: string): string | null {
    return this.slots.get(ws)?.ws?.root ?? null;
  }

  open(ws: string, dir: string, persist = true) {
    const s = this.slot(ws);
    const next = Workspace.open(dir, { emit: (e) => this.opts.emit(ws, e), autoSnapshot: () => this.autoSnapshot() });
    s.ws?.close();
    s.ws = next;
    if (persist) this.persistLibrary(next.root, ws === "main");
    return next.info();
  }

  /** 关窗：关掉文库并杀掉这个窗口的会话进程 */
  closeWindow(ws: string): void {
    const s = this.slots.get(ws);
    if (!s) return;
    s.ws?.close();
    s.procs.killAll(true);
    this.slots.delete(ws);
  }

  shutdown(): void {
    for (const ws of [...this.slots.keys()]) this.closeWindow(ws);
  }

  /* ---------------- 调用 ---------------- */

  async call(method: string, params: unknown): Promise<unknown> {
    const p = (params && typeof params === "object" && !Array.isArray(params) ? params : {}) as Params;
    const fn = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined;
    if (!fn) throw httpError(404, `未知方法 ${method}`);
    const ws = p.ws === undefined ? "main" : str(p, "ws");
    return fn(this, ws, p);
  }

  /** Openfile 统一管理的对话档案库 = 主文件夹（默认 ~/.openfile），本身是个文库，可以当文库打开检索 */
  conversationsRoot(): string {
    return ensureOpenfileHome();
  }

  /**
   * 导出对话：另起 Node 跑本运行时的 `openfile import-sessions`，把本机各家 CLI 的对话转成 Markdown 存进统一档案库
   * （conversationsRoot 的 会话/导入/<项目>/），不往当前文件夹写任何东西。scope=folder 只导在当前文件夹里干过活的会话，
   * scope=all 导本机全部项目。纯解析本机转写，不调模型、不联网；返回导出器打印的摘要与档案库路径，退出码非 0 也照常带回输出。
   */
  async exportConversations(ws: string, scope: "all" | "folder", expectedRoot: string | null): Promise<{ ok: boolean; output: string; archiveRoot: string; summary: ExportSummary | null }> {
    const archiveRoot = this.conversationsRoot();
    const scopeArgs = scope === "all" ? ["--all-projects"] : ["--project", this.workspace(ws).bound(expectedRoot)];
    const args = [this.opts.cliEntry, "import-sessions", "--root", archiveRoot, ...scopeArgs];
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      child.stdout.setEncoding("utf8").on("data", (s: string) => (stdout += s));
      child.stderr.setEncoding("utf8").on("data", (s: string) => (stderr += s));
      child.once("error", (err) => resolve({ code: null, stdout, stderr: stderr || err.message }));
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    const raw = (out.stdout + (out.stderr ? `\n${out.stderr}` : "")).trim().split("\n");
    const lines = raw.map((l) => exportWording(l, scope)).filter((l) => l !== null);
    return { ok: out.code === 0, output: lines.slice(-60).join("\n"), archiveRoot, summary: exportSummary(raw) };
  }
}

/** 导出结果的数字：界面按当前语言自己组句（运行时只有中文） */
interface ExportSummary {
  found: boolean;
  exported: number;
  refreshed: number;
  skipped: number;
  /** 属于别的项目或缺少来源而跳过的份数（只在只导出当前文件夹时有） */
  outside: number;
  redactions: number;
  /** 疑似密钥、没有自动替换的长串条数 */
  suspects: number;
}

function exportSummary(lines: string[]): ExportSummary | null {
  const s: ExportSummary = { found: true, exported: 0, refreshed: 0, skipped: 0, outside: 0, redactions: 0, suspects: 0 };
  let done = false;
  for (const line of lines) {
    if (line.startsWith("没有发现可导入的会话")) return { ...s, found: false };
    let m = /^完成：导入 (\d+)，刷新 (\d+)，跳过 (\d+)。$/.exec(line);
    if (m) { s.exported = +m[1]; s.refreshed = +m[2]; s.skipped = +m[3]; done = true; continue; }
    if ((m = /^其中 (\d+) 份属于其他项目或缺少项目来源/.exec(line))) s.outside = +m[1];
    else if ((m = /^已脱敏 (\d+) 处/.exec(line))) s.redactions = +m[1];
    else if ((m = /^⚠ 疑似高熵 token (\d+) 条/.exec(line))) s.suspects = +m[1];
  }
  return done ? s : null;
}

/** 导出器打印的是命令行措辞（导入 / --file / --all-projects）：界面上统一说「导出」，命令行提示换成按钮的说法；返回 null = 这行不显示 */
function exportWording(line: string, scope: "all" | "folder"): string | null {
  const done = /^完成：导入 (\d+)，刷新 (\d+)，跳过 (\d+)。$/.exec(line);
  if (done) return `完成：导出 ${done[1]}，刷新 ${done[2]}，跳过 ${done[3]}。`;
  const other = /^其中 (\d+) 份属于其他项目或缺少项目来源/.exec(line);
  if (other) return scope === "folder" ? `其中 ${other[1]} 份属于其他文件夹或缺少来源，用「导出所有对话」可以一并导出。` : null;
  if (line.startsWith("没有发现可导入的会话")) return "没有发现可导出的对话。";
  return line.replace(/^已入库: /, "已导出: ");
}

type Method = (h: Host, ws: string, p: Params) => unknown;

/** 方法表：名字即契约（backend.ts 与 Rust 中继都按这里调用） */
const METHODS: Record<string, Method> = {
  "library.get": (h, ws) => {
    try {
      return h.workspace(ws).info();
    } catch {
      return null;
    }
  },
  "library.open": (h, ws, p) => h.open(ws, str(p, "path"), p.persist !== false),
  /** 桌面端启动时由 Rust 调：打开 settings 里上次的文库（不在了给 null） */
  "library.restore": (h, ws) => {
    const lib = h.persistedLibrary();
    return lib ? h.open(ws, lib, false) : null;
  },
  "library.recents": (h) => h.recents(),
  "library.closeWindow": (h, ws) => h.closeWindow(ws),

  "index.count": (h, ws) => h.workspace(ws).indexCount(),
  "index.search": (h, ws, p) => h.workspace(ws).search(str(p, "query"), Math.min(optNum(p, "limit") ?? 50, 200)),
  "index.rebuild": (h, ws) => void h.workspace(ws).buildIndex(),

  "fs.list": (h, ws, p) => {
    const w = h.workspace(ws);
    w.bound(p.expectedRoot);
    return w.list(str(p, "rel"));
  },
  "fs.readText": (h, ws, p) => {
    const w = h.workspace(ws);
    w.bound(p.expectedRoot);
    return w.readText(str(p, "rel"), optNum(p, "maxBytes"));
  },
  "fs.readBinary": (h, ws, p) => h.workspace(ws).readBinary(str(p, "rel")),
  "fs.stat": (h, ws, p) => h.workspace(ws).stat(str(p, "rel")),
  "fs.write": (h, ws, p) => {
    const baseline = p.expectedContent as { content: string | null } | undefined | null;
    h.workspace(ws).write(str(p, "rel"), str(p, "content"), optStr(p, "expectedRoot"), baseline === null ? undefined : baseline);
  },
  // 文献 PDF 转 Markdown 笔记
  "pdf.toMarkdown": (h, ws, p) => h.workspace(ws).pdfToMarkdown(str(p, "rel"), optStr(p, "expectedRoot")),
  // HTML 转 Markdown 审阅稿
  "html.toReview": (h, ws, p) => h.workspace(ws).htmlToReview(str(p, "rel"), optStr(p, "expectedRoot")),
  // Word 往返
  "docx.import": (h, ws, p) => h.workspace(ws).importDocx(str(p, "rel"), optStr(p, "expectedRoot")),
  "docx.export": (h, ws, p) =>
    h.workspace(ws).exportDocx(str(p, "rel"), os.userInfo().username || "我", optStr(p, "expectedRoot")),

  // 内嵌会话档案：文件夹还不是文库（没有 .openfile/）时放应用数据目录；是文库时前端用 fs.write 写 会话/内嵌/
  "archive.inLibrary": (h, ws, p) => isLibraryRoot(h.workspace(ws).bound(str(p, "expectedRoot"))),
  "archive.write": (h, ws, p) =>
    writeSessionArchive(h.opts.appData ?? folderAppData(), h.workspace(ws).bound(str(p, "expectedRoot")), str(p, "name"),
      str(p, "content"), p.expectedContent === null ? null : str(p, "expectedContent")),
  "archive.list": (h, ws, p) => listSessionArchives(h.opts.appData ?? folderAppData(), h.workspace(ws).bound(str(p, "expectedRoot"))),
  "archive.read": (h, ws, p) =>
    readSessionArchive(h.opts.appData ?? folderAppData(), h.workspace(ws).bound(str(p, "expectedRoot")), str(p, "name"), optNum(p, "maxBytes")),

  // 目录项操作：出证全在 file-ops.mjs 的 resolveEntry；桌面端的废纸篓与「在访达中显示」走 Rust 原生
  "fileop.mkdir": (h, ws, p) => createDirAt(h.workspace(ws).bound(p.expectedRoot), str(p, "dir"), str(p, "name")),
  "fileop.rename": (h, ws, p) => renameEntryAt(h.workspace(ws).bound(p.expectedRoot), str(p, "rel"), str(p, "name")),
  "fileop.move": (h, ws, p) => moveEntryAt(h.workspace(ws).bound(p.expectedRoot), str(p, "rel"), str(p, "dir")),
  "fileop.copy": (h, ws, p) => copyEntryAt(h.workspace(ws).bound(p.expectedRoot), str(p, "rel"), str(p, "dir")),
  "fileop.info": (h, ws, p) => entryInfoAt(h.workspace(ws).bound(p.expectedRoot), str(p, "rel")),
  "fileop.trash": (h, ws, p) => void trashEntryAt(h.workspace(ws).bound(p.expectedRoot), str(p, "rel")),
  "fileop.reveal": (h, ws, p) => void revealEntryAt(h.workspace(ws).bound(p.expectedRoot), str(p, "rel")),

  "snapshot.now": (h, ws, p) => h.workspace(ws).snapshot(optStr(p, "label")),
  "snapshot.list": async (h, ws, p) => (await h.workspace(ws).shadow()).list(Math.min(optNum(p, "limit") ?? 100, 500)),
  "snapshot.changes": async (h, ws, p) => (await h.workspace(ws).shadow()).changes(str(p, "id"), optStr(p, "from")),
  "snapshot.diffFile": async (h, ws, p) =>
    (await h.workspace(ws).shadow()).diffPair(str(p, "path"), str(p, "from"), optStr(p, "to")),
  "snapshot.readB64": async (h, ws, p) => {
    const buf = await (await h.workspace(ws).shadow()).bytes(str(p, "id"), str(p, "path"));
    return buf ? { b64: buf.toString("base64"), size: buf.length } : null;
  },
  "snapshot.restoreFile": (h, ws, p) => h.workspace(ws).restoreFile(str(p, "id"), str(p, "path")),
  "snapshot.restore": (h, ws, p) => h.workspace(ws).restoreSnapshot(str(p, "id")),
  "snapshot.getAuto": (h) => h.autoSnapshot(),
  "snapshot.setAuto": (h, _ws, p) => {
    if (typeof p.enabled !== "boolean") throw httpError(400, "缺少 enabled");
    h.setAutoSnapshot(p.enabled);
  },

  "proc.spawnAgent": (h, ws, p) => {
    const args = p.args ?? [];
    const root = h.workspace(ws).root;
    const cmd = str(p, "cmd");
    h.procs(ws).spawn(str(p, "pid"), knownCommand(cmd) ?? cmd, args as string[], root);
  },
  "proc.write": (h, ws, p) => h.procs(ws).write(str(p, "pid"), str(p, "data")),
  "proc.kill": (h, ws, p) => h.procs(ws).kill(str(p, "pid")),

  /** 会话注入的 Openfile MCP：本运行时的 node + openfile 入口（--root = 当前文库；读文件、审阅、快照三组全开） */
  "agent.mcpServer": (h, ws, p) => ({
    command: process.execPath,
    args: [h.opts.cliEntry, "mcp", "--root", h.workspace(ws).bound(str(p, "expectedRoot")), "--tools", "all"],
  }),
  "conversations.export": (h, ws, p) => {
    const scope = p.scope === "all" ? "all" : p.scope === "folder" ? "folder" : null;
    if (!scope) throw httpError(400, "scope 只接受 all | folder");
    return h.exportConversations(ws, scope, scope === "folder" ? str(p, "expectedRoot") : null);
  },
  "conversations.root": (h) => h.conversationsRoot(),

  "user.name": () => os.userInfo().username || "我",
};
