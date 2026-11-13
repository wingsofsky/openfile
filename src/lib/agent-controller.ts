/**
 * ACP 会话控制器 —— 协议接线的唯一实现。
 *
 * 分层：backend.spawnAgent 提供哑字节管道（运行时 api/processes.ts，桌面与 dev 同一份）
 * → 官方 @agentclientprotocol/sdk 做 JSON-RPC 帧与方法面
 * → 本模块实现 Client 侧（fs 代理 / 权限 / update 折叠），状态写进 useAgent。
 *
 * 安全不变量（CONTRIBUTING.md 不变量 1）：agent 的 fs/read_text_file、
 * fs/write_text_file 递来的**绝对路径**先经 absToRel 词法映射回库内相对
 * 路径（根之外直接拒绝），再走 scoped 后端——realpath 级复验仍在
 * Rust scope.rs / scoped.mjs，本层只是快速失败。app 之手绝不越库。
 *
 * 每个会话在 session/new 时注入 Openfile MCP（stdio，full profile，--root 为同一文库），
 * agent 因此能用 suggest_edit、快照等工具；拉起方式由后端给（agentMcpServer），找不到 Node 就照常开会话。
 *
 * 模块级单例（不进 React 生命周期）：StrictMode 双挂载、面板开合、
 * 视图热切换都不会打断会话进程。
 */
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type {
  Client,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  McpServerStdio,
  SessionNotification,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import { absToRel, applyUpdate, plainPath, sliceLines, type TranscriptItem } from "./acp";
import { backend } from "./backend";
import { useAgent, AGENT_PRESETS, type PermissionAsk } from "../state/agent";
import { useApp } from "../state/store";
import type { AgentProcessHandle } from "./types";
import { createSessionWriter, formatHistoryContext, historySource, readHistoryContext, serializeSession, type SessionRecord } from "./session-history";
import { currentFileContext } from "../state/agent-context";
import { documentChanges, planTurnUndo, turnLabel } from "./turn-changes";
import { t } from "../i18n";

/* ------------------------------------------------------------------ */
/* 纯辅助（可单测）                                                      */
/* ------------------------------------------------------------------ */

/** 自定义命令行 → argv：支持单双引号包裹（含空格路径），不做转义与展开 */
export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let quoted = false;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      quoted = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (cur !== "" || quoted) {
        out.push(cur);
        cur = "";
        quoted = false;
      }
      continue;
    }
    cur += c;
  }
  if (cur !== "" || quoted) out.push(cur);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 启动失败的人话：dev 桥对已退出的进程回 404 JSON（{"error":"会话进程已退出"}），
 * 真正原因（spawn ENOENT）只在 stderr 里——这里把两者合成一句给人看。
 */
export function friendlyStartError(e: unknown, stderrTail: string[]): string {
  for (const line of stderrTail) {
    const m = /spawn (\S+) ENOENT/.exec(line);
    if (m) return t("找不到命令「{0}」——这台机器上没装或不在登录 shell 的 PATH 里（安装方式见预设说明）；装在别处时可改用「自定义命令」填绝对路径", [m[1]]);
  }
  let msg = errMsg(e);
  if (/^\s*\{/.test(msg)) {
    try {
      const j = JSON.parse(msg) as { error?: unknown };
      if (typeof j.error === "string" && j.error) msg = j.error;
    } catch {
      /* 不是 JSON，原样 */
    }
  }
  return msg;
}

/** Gemini CLI 个人账号通道已停用时 stderr 里的那句话 */
export const GEMINI_RETIRED = /no longer supported for Gemini Code Assist/i;
const geminiRetiredHint = () => t("Google 已于 2026-06-18 停止 Gemini CLI 的个人 Google 账号登录（免费 / AI Pro / Ultra 都并入 Antigravity）。Gemini CLI 现在只能用 API key（在 shell 配置里设 GEMINI_API_KEY）或 Vertex AI；用 Google 账号订阅的请改走 Antigravity。");

/** 未登录的提示：适配器只在通知里说 Not logged in，第一轮才报 Authentication required */
const authHint = () => t("先在终端完成登录（Claude Code：claude login；Codex：codex login；或设置对应 API key），再重启会话");

/** ACP auth_required（RequestError.authRequired 的错误码） */
const isAuthRequired = (e: unknown) => e instanceof RequestError && e.code === -32000;

/* ------------------------------------------------------------------ */
/* 会话单例                                                             */
/* ------------------------------------------------------------------ */

interface Live {
  gen: number;
  root: string;
  label: string;
  proc: AgentProcessHandle;
  conn: ClientSideConnection;
  sessionId: string | null;
  permQueue: Array<{ ask: PermissionAsk; resolve: (r: RequestPermissionResponse) => void }>;
  cancelling: boolean;
  /** 本会话发过几轮（快照标签「会话第 N 轮前 / 后」用） */
  turn: number;
  /** 已把 spawn ENOENT 翻成人话提示过（stderr 行可能晚于写失败到达） */
  enoentNoted?: boolean;
  retiredNoted?: boolean;
}

let live: Live | null = null;
let genCounter = 0;
let moduleActive = true;

interface Archive {
  record: SessionRecord;
  writer: ReturnType<typeof createSessionWriter>;
}
let archive: Archive | null = null;
const pausedArchives = new Map<string, Archive[]>();

const st = useAgent.setState;
const info = (text: string) =>
  st((s) => ({ transcript: [...s.transcript, { kind: "info", text } as TranscriptItem] }));

function updateArchive() {
  if (!archive) return;
  const ui = useAgent.getState();
  archive.record = { ...archive.record, transcript: ui.transcript, status: ui.status, agent: ui.agentName ?? archive.record.agent };
  archive.writer.update(serializeSession(archive.record));
}

const unsubscribeAgent = useAgent.subscribe((s, prev) => {
  if (s.transcript !== prev.transcript || s.status !== prev.status || s.agentName !== prev.agentName) {
    updateArchive();
    if (s.status !== "running" && s.status !== "starting") void archive?.writer.flush();
  }
});

export async function flushSessionArchive(): Promise<boolean> {
  updateArchive();
  const root = useApp.getState().lib?.root;
  const pending = root ? pausedArchives.get(root) ?? [] : [];
  for (const old of pending) {
    if (!await old.writer.resume()) return false;
  }
  if (root) pausedArchives.delete(root);
  return archive ? archive.writer.flush() : true;
}

const hasUnsavedArchive = () => !!archive?.writer.dirty || [...pausedArchives.values()].some((items) => items.some((item) => item.writer.dirty));

// Browser process termination cannot await promises. Warn while dirty, and reduce
// the remaining window on pagehide. Normal desktop close waits below.
if (typeof window !== "undefined") {
  const pagehide = () => { void flushSessionArchive(); };
  const beforeunload = (event: BeforeUnloadEvent) => {
    if (hasUnsavedArchive()) { event.preventDefault(); event.returnValue = ""; }
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") void flushSessionArchive();
  };
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("beforeunload", beforeunload);
  document.addEventListener("visibilitychange", visibility);
  let removeCloseListener: (() => void) | null = null;
  let disposed = false;
  if (backend.kind === "tauri") void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    let closing = false;
    // macOS：红灯收起窗口与 Dock 图标，应用与会话留在后台（Finder / Spotlight 重新打开）；
    // 真退出走 ⌘Q。其它平台关窗即退出，仍须先停会话并落盘。
    // 多窗口：只有主窗口收起 / 留后台；别的窗口关掉就是关掉（停会话、落盘后销毁，运行时随之关它的库）
    const isMain = win.label === "main";
    const hideOnClose = isMain && /Mac/.test(navigator.platform ?? "");
    const remove = await win.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closing) return;
      closing = true;
      try {
        if (hideOnClose) {
          void flushSessionArchive();
          await (await import("@tauri-apps/api/core")).invoke("hide_main_window");
          return;
        }
        if (await stopSession() && !hasUnsavedArchive()) await win.destroy();
        else st({ panelOpen: true, error: t("会话尚未保存，窗口保持打开；请重试保存。") });
      } catch (e) {
        st({ panelOpen: true, error: t("无法关闭窗口：{0}", [errMsg(e)]) });
      } finally { closing = false; }
    });
    if (disposed) remove(); else removeCloseListener = remove;
  }).catch((e) => st({ error: t("无法注册关闭前保存：{0}", [errMsg(e)]) }));
  import.meta.hot?.dispose(() => {
    disposed = true;
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("beforeunload", beforeunload);
    document.removeEventListener("visibilitychange", visibility);
    removeCloseListener?.();
  });
}

function flushPermissions(l: Live) {
  for (const q of l.permQueue.splice(0)) q.resolve({ outcome: { outcome: "cancelled" } });
  st({ permission: null });
}

/** 文库一换，旧会话立即作废（fs 代理的 root 语义变了，绝不跨库复用） */
const unsubscribeApp = useApp.subscribe((s, prev) => {
  if (s.lib?.root === prev.lib?.root) return;
  const old = archive;
  archive = null;
  if (old?.writer.dirty) {
    old.record = { ...old.record, status: "library_changed" };
    old.writer.update(serializeSession(old.record));
    old.writer.pause();
    const waiting = pausedArchives.get(old.writer.root) ?? [];
    waiting.push(old);
    pausedArchives.set(old.writer.root, waiting);
  }
  void stopSession();
  st({ transcript: [], archive: null, historyContext: null, contextSources: [], agentName: null, error: null, turnChanges: null });
  if (s.lib?.root && pausedArchives.has(s.lib.root)) void flushSessionArchive();
});

/* ------------------------------------------------------------------ */
/* Client 侧实现（fs 代理 + 权限 + update 折叠）                          */
/* ------------------------------------------------------------------ */

function makeClient(myGen: number, root: string): Client {
  const stale = () => live?.gen !== myGen;
  const relOf = (abs: string): string => {
    const rel = absToRel(root, abs);
    if (rel === null) {
      throw RequestError.invalidParams({ path: abs }, "路径在文库之外，Openfile 拒绝代理");
    }
    return rel;
  };
  return {
    sessionUpdate(n: SessionNotification) {
      if (stale() || !live) return;
      if (live.sessionId !== null && n.sessionId !== live.sessionId) return;
      const u = n.update;
      if (u.sessionUpdate === "available_commands_update") {
        st({
          commands: u.availableCommands.map((c) => ({ name: c.name, description: c.description ?? "" })),
        });
        return;
      }
      if (u.sessionUpdate === "usage_update") {
        // used = 当前上下文占用（压缩后会掉），不是累计消耗；累计只有可选的 cost
        st({
          usage: {
            used: u.used,
            size: u.size,
            cost: u.cost ? { amount: u.cost.amount, currency: u.cost.currency } : null,
          },
        });
        return;
      }
      if (u.sessionUpdate === "current_mode_update") {
        st((s) =>
          s.modes ? { modes: { ...s.modes, currentModeId: u.currentModeId } } : {},
        );
        return;
      }
      st((s) => {
        const next = applyUpdate(s.transcript, u);
        return next === s.transcript ? {} : { transcript: next };
      });
    },

    /** 扩展通知：claude-agent-acp 的 _auth/status_update 会在建会话后说明登录态 */
    extNotification(method: string, params: Record<string, unknown>) {
      if (stale() || !live) return;
      if (method !== "_auth/status_update") return;
      const a = (params as { authStatus?: { kind?: string; label?: string } }).authStatus;
      if (!a) return;
      if (a.kind === "none") {
        const label = a.label ?? "Not logged in";
        if (useAgent.getState().authNote !== label) {
          st({ authNote: label });
          info(t("agent 报告未登录（{0}）：{1}。", [label, authHint()]));
        }
      } else {
        st({ authNote: null });
      }
    },

    requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      if (stale() || !live || live.cancelling) {
        return Promise.resolve({ outcome: { outcome: "cancelled" } });
      }
      const ask: PermissionAsk = {
        title: p.toolCall?.title ?? t("工具调用"),
        options: p.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      };
      const l = live;
      return new Promise((resolve) => {
        l.permQueue.push({ ask, resolve });
        if (l.permQueue.length === 1) st({ permission: ask });
      });
    },

    async readTextFile(p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      if (stale() || useApp.getState().lib?.root !== root) throw RequestError.invalidParams(undefined, "会话文库已变化");
      const rel = relOf(p.path);
      let r;
      try {
        r = await backend.readText(rel, undefined, root);
      } catch {
        throw RequestError.resourceNotFound(p.path);
      }
      if (r.encoding === "binary") {
        throw RequestError.internalError(undefined, "二进制文件不提供文本读取");
      }
      if (r.truncated) {
        throw RequestError.internalError(undefined, "文件超过读取上限（4MB）");
      }
      return { content: sliceLines(r.content, p.line, p.limit) };
    },

    async writeTextFile(p: WriteTextFileRequest) {
      if (stale() || useApp.getState().lib?.root !== root) throw RequestError.invalidParams(undefined, "会话文库已变化");
      const rel = relOf(p.path);
      await backend.writeText(rel, p.content, root);
      return {};
    },
  };
}

/* ------------------------------------------------------------------ */
/* 生命周期 API（AgentPanel 调用）                                       */
/* ------------------------------------------------------------------ */

export async function startSession(): Promise<void> {
  const ui = useAgent.getState();
  const preset = AGENT_PRESETS.find((p) => p.id === ui.presetId) ?? AGENT_PRESETS[0];
  let cmd = preset.cmd;
  let args = preset.args;
  let label = preset.label;
  if (preset.id === "custom") {
    const argv = parseCommandLine(ui.customCmd);
    if (argv.length === 0) {
      st({ status: "error", error: t("请先填写自定义命令") });
      return;
    }
    [cmd, ...args] = argv as [string, ...string[]];
    label = cmd;
  }
  const root = useApp.getState().lib?.root;
  if (!root) {
    st({ status: "error", error: t("尚未选择文库") });
    return;
  }
  if (live) await stopSession();
  if (!await flushSessionArchive()) {
    st({ error: t("上一会话尚未保存，请重试保存后再启动。") });
    return;
  }
  if (useApp.getState().lib?.root !== root) return;
  // 文件夹还不是文库（没有 .openfile/）时，档案存应用数据目录，不往文件夹里写
  let inLibrary: boolean;
  try {
    inLibrary = await backend.archiveInLibrary(root);
  } catch (e) {
    if (useApp.getState().lib?.root === root) st({ status: "error", error: errMsg(e) });
    return;
  }
  if (useApp.getState().lib?.root !== root) return;

  const myGen = ++genCounter;
  const stale = () => live?.gen !== myGen;
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const path = inLibrary ? `会话/内嵌/${id}.md` : `${id}.md`;
  const writer = createSessionWriter({
    root, path, inLibrary,
    write: (rel, content, expectedRoot, expectedContent) => inLibrary
      ? backend.writeText(rel, content, expectedRoot, expectedContent)
      : backend.writeArchive(rel, content, expectedRoot, expectedContent),
    onState: (state) => {
      if (moduleActive && useApp.getState().lib?.root === root && (!archive || archive.writer.path === path)) st({ archive: state });
    },
  });
  archive = {
    writer,
    record: { id, startedAt: new Date().toISOString(), agent: preset.id === "custom" ? "自定义 agent" : label, status: "starting", transcript: [] },
  };
  st({
    status: "starting",
    transcript: [],
    permission: null,
    modes: null,
    authMethods: [],
    error: null,
    stderrTail: [],
    agentName: null,
    commands: [],
    authNote: null,
    usage: null,
    contextSources: [],
    turnChanges: null,
  });
  info(t("启动 {0}：{1}", [label, `${cmd} ${args.join(" ")}`.trim()]));
  if (cmd === "npx") info(t("首次启动要经 npx 下载适配器，可能需要一两分钟；请稍等。"));

  let proc: AgentProcessHandle;
  try {
    proc = await backend.spawnAgent(cmd, args);
    if (genCounter !== myGen || useApp.getState().lib?.root !== root) {
      await proc.kill().catch(() => undefined);
      return;
    }
  } catch (e) {
    if (genCounter !== myGen || useApp.getState().lib?.root !== root) return;
    st({ status: "error", error: errMsg(e) });
    return;
  }

  // 字节管道 → SDK ndjson 流（帧粒度写入，chunk 即完整帧，可安全按文本解码）
  let readClosed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      proc.onStdout((b) => {
        if (readClosed) return;
        try {
          controller.enqueue(b);
        } catch {
          readClosed = true;
        }
      });
      proc.onExit(() => {
        if (readClosed) return;
        readClosed = true;
        try {
          controller.close();
        } catch {
          /* 已关 */
        }
      });
    },
  });
  const decoder = new TextDecoder();
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => proc.write(decoder.decode(chunk)),
  });
  const conn = new ClientSideConnection(
    () => makeClient(myGen, root),
    ndJsonStream(writable, readable),
  );

  const l: Live = {
    gen: myGen,
    root,
    label,
    proc,
    conn,
    sessionId: null,
    permQueue: [],
    cancelling: false,
    turn: 0,
  };
  live = l;

  proc.onStderr((line) => {
    if (stale()) return;
    st((s) => ({ stderrTail: [...s.stderrTail.slice(-39), line] }));
    // spawn ENOENT 常晚于 stdin 写失败到达：一到就把错误升级成人话（只提示一次）
    const m = /spawn (\S+) ENOENT/.exec(line);
    if (m && !l.enoentNoted) {
      l.enoentNoted = true;
      const msg = friendlyStartError(new Error(line), [line]);
      st((s) => (s.status === "error" || s.status === "starting" ? { error: msg } : {}));
      info(msg);
    }
    // Google 2026-06-18 停掉了 Gemini CLI 的个人 Google 账号登录（免费 / AI Pro / Ultra），只报一行英文错
    if (GEMINI_RETIRED.test(line) && !l.retiredNoted) {
      l.retiredNoted = true;
      st({ error: geminiRetiredHint() });
      info(geminiRetiredHint());
    }
  });
  proc.onExit((code) => {
    if (stale()) return;
    flushPermissions(l);
    live = null;
    st((s) => ({ status: s.status === "error" ? "error" : "exited" }));
    info(code !== null ? t("agent 进程已退出（代码 {0}）。", [code]) : t("agent 进程已退出。"));
  });

  try {
    const init = await withTimeout(
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: "openfile", version: "0.1.0" },
      }),
      120_000,
      t("适配器 120s 无响应——首次启动要经 npx 下载适配器；检查网络是否可达，或展开诊断输出看 npm 卡在哪"),
    );
    if (stale()) return;
    const agentInfo = init.agentInfo as { name?: string; title?: string | null } | undefined;
    st({
      agentName: agentInfo?.title || agentInfo?.name || label,
      authMethods: (init.authMethods ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
      })),
    });
    await establishSession(l, stale);
  } catch (e) {
    if (stale()) return;
    const msg = friendlyStartError(e, useAgent.getState().stderrTail);
    st({ status: "error", error: msg });
    info(t("启动失败：{0}", [msg]));
    void proc.kill();
  }
}

/**
 * 注入的 MCP 名。不能叫 `openfile`：用户自己的 agent 配置里常已有同名条目（指向别的文库），
 * codex-acp 遇到同名就用配置里那份、不启动注入的。
 */
const SESSION_MCP_NAME = "openfile-session";

/** 本会话注入的 Openfile MCP。拿不到（没有 Node、后端出错）就不注入，在转写里说明一次。 */
async function openfileMcp(root: string): Promise<McpServerStdio[]> {
  try {
    const spec = await backend.agentMcpServer(root);
    if (spec) return [{ name: SESSION_MCP_NAME, command: spec.command, args: spec.args, env: [] }];
    info(t("本会话没有 Openfile 工具：找不到 Node.js 22+。会话照常进行。"));
  } catch (e) {
    info(t("本会话没有 Openfile 工具：{0}", [errMsg(e)]));
  }
  return [];
}

/* ---- 本轮改动（3a-2，契约见 turn-changes.ts 头注释） ---- */

/** 强制拍一张快照（不看自动快照开关）；没有变化时用当时最新的快照 */
async function snapshotOrLatest(label: string): Promise<string | null> {
  const s = await backend.snapshotNow(label);
  return s?.id ?? (await backend.listSnapshots(1))[0]?.id ?? null;
}

async function turnBaseline(l: Live, turn: number): Promise<string | null> {
  if (useApp.getState().lib?.root !== l.root) return null;
  try {
    return await snapshotOrLatest(turnLabel(turn, "前"));
  } catch (e) {
    info(t("第 {0} 轮没拍到轮前快照（{1}），这一轮的改动不会标出。", [turn, errMsg(e)]));
    return null;
  }
}

async function finishTurn(l: Live, turn: number, baseId: string, stale: () => boolean): Promise<void> {
  try {
    if (useApp.getState().lib?.root !== l.root) return;
    const headId = await snapshotOrLatest(turnLabel(turn, "后"));
    if (stale() || !headId || useApp.getState().lib?.root !== l.root) return;
    const files = headId === baseId ? [] : documentChanges(await backend.snapshotChanges(headId, baseId));
    // 期间又开了新的一轮：这一轮的结果作废（撤回只针对最近结束的一轮）
    if (stale() || l.turn !== turn) return;
    st({ turnChanges: { root: l.root, turn, baseId, headId, files } });
  } catch (e) {
    if (!stale()) info(t("第 {0} 轮的改动没能统计出来：{1}", [turn, errMsg(e)]));
  }
}

/**
 * 整轮撤回：本轮改过 / 删掉的恢复成轮前内容，新建的进废纸篓。先拍一张快照，
 * 轮后又被改过的文件跳过并列出（不盖掉别人的改动）。只在本轮结束后可用。
 */
export async function undoTurn(): Promise<void> {
  const s = useAgent.getState();
  const tc = s.turnChanges;
  if (!tc || s.turnUndoing || s.status === "running" || useApp.getState().lib?.root !== tc.root) return;
  st({ turnUndoing: true });
  try {
    const nowId = await snapshotOrLatest("撤回本轮前");
    if (useApp.getState().lib?.root !== tc.root) throw new Error(t("文库已切换"));
    const touched = !nowId || nowId === tc.headId ? [] : (await backend.snapshotChanges(nowId, tc.headId)).map((f) => f.path);
    const plan = planTurnUndo(tc.files, touched);
    const failed: string[] = [];
    const fail = (p: string) => (e: unknown) => failed.push(`${p}（${errMsg(e)}）`);
    for (const p of plan.restore) await backend.restoreFile(tc.baseId, p).catch(fail(p));
    for (const p of plan.trash) await backend.trashEntry(p, tc.root).catch(fail(p));
    const done = plan.restore.length + plan.trash.length - failed.length;
    const parts = [done > 0 || !failed.length ? t("已撤回第 {0} 轮：{1} 个文件回到轮前。", [tc.turn, done]) : t("第 {0} 轮没撤成。", [tc.turn])];
    if (plan.skipped.length) parts.push(t("轮后又被改过、没动：{0}。", [plan.skipped.join(t("、"))]));
    if (failed.length) parts.push(t("没撤成：{0}。", [failed.join(t("、"))]));
    info(parts.join(""));
    // 有没撤成的就留着卡片，可以处理后重试（已恢复的文件重试时会因「轮后又被改过」被跳过）
    if (!failed.length && useAgent.getState().turnChanges === tc) st({ turnChanges: null });
  } catch (e) {
    info(t("撤回失败：{0}", [errMsg(e)]));
  } finally {
    st({ turnUndoing: false });
  }
}

/**
 * 整份撤回一个文件（docx 写不回逐段撤回）。规矩同整轮撤回：先拍一张快照，轮后又被改过就不动；
 * 改过的恢复成轮前，本轮新建的进废纸篓。撤成后这个文件从本轮改动里去掉，整轮撤回不再管它。
 * 返回给视图显示的结果（同一句也进会话记录）；条件不满足（不是本轮改的、正在跑、正在撤）返回 null。
 */
export async function undoTurnFile(rel: string): Promise<string | null> {
  const s = useAgent.getState();
  const tc = s.turnChanges;
  const file = tc?.files.find((f) => f.path === rel);
  if (!tc || !file || s.turnUndoing || s.status === "running" || useApp.getState().lib?.root !== tc.root) return null;
  st({ turnUndoing: true });
  let message: string;
  try {
    const nowId = await snapshotOrLatest("撤回本轮前");
    if (useApp.getState().lib?.root !== tc.root) throw new Error(t("文库已切换"));
    const touched = !nowId || nowId === tc.headId ? [] : (await backend.snapshotChanges(nowId, tc.headId)).map((f) => f.path);
    const plan = planTurnUndo([file], touched);
    if (plan.restore.length) {
      await backend.restoreFile(tc.baseId, rel);
      message = t("已把 {0} 撤回到第 {1} 轮之前。", [rel, tc.turn]);
    } else if (plan.trash.length) {
      await backend.trashEntry(rel, tc.root);
      message = t("已把第 {0} 轮新建的 {1} 移到废纸篓。", [tc.turn, rel]);
    } else {
      message = t("{0} 在第 {1} 轮之后又被改过，没动。", [rel, tc.turn]);
    }
    if (!plan.skipped.length && useAgent.getState().turnChanges === tc) {
      const files = tc.files.filter((f) => f.path !== rel);
      st({ turnChanges: files.length ? { ...tc, files } : null });
    }
  } catch (e) {
    message = t("撤回失败：{0}", [errMsg(e)]);
  } finally {
    st({ turnUndoing: false });
  }
  info(message);
  return message;
}

async function establishSession(l: Live, stale: () => boolean): Promise<void> {
  try {
    const mcpServers = await openfileMcp(l.root);
    if (stale()) return;
    // cwd 给普通路径：Windows 上 `\\?\D:\库` 形式的根交给 agent 会被当成另一个目录（或直接拒绝）
    const ns = await l.conn.newSession({ cwd: plainPath(l.root), mcpServers });
    if (stale()) return;
    l.sessionId = ns.sessionId;
    st({
      status: "ready",
      modes: ns.modes
        ? {
            currentModeId: ns.modes.currentModeId,
            availableModes: ns.modes.availableModes.map((m) => ({ id: m.id, name: m.name })),
          }
        : null,
    });
    info(t("会话已建立（{0}）。", [useAgent.getState().agentName ?? l.label]));
  } catch (e) {
    if (stale()) return;
    if (isAuthRequired(e)) {
      st({ status: "auth" });
      info(t("agent 要求先登录。选择下方的登录方式，或先在终端完成登录再重启会话。"));
      return;
    }
    throw e;
  }
}

export async function authenticate(methodId: string): Promise<void> {
  const l = live;
  if (!l) return;
  const myGen = l.gen;
  const stale = () => live?.gen !== myGen;
  try {
    await l.conn.authenticate({ methodId });
    if (stale()) return;
    await establishSession(l, stale);
  } catch (e) {
    if (stale()) return;
    st({ error: errMsg(e) });
    info(t("登录失败：{0}", [errMsg(e)]));
  }
}

export function sendPrompt(text: string): void {
  const l = live;
  if (!l || l.sessionId === null || useAgent.getState().status !== "ready") return;
  const myGen = l.gen;
  const stale = () => live?.gen !== myGen;
  l.cancelling = false;
  const turn = ++l.turn;
  // 轮前快照拍到之后才有本轮的基线；拍失败（或被取消）就是 null，本轮不标改动
  let baseId: string | null = null;
  st((s) => ({
    status: "running",
    turnChanges: null,
    transcript: [...s.transcript, { kind: "user", text } as TranscriptItem],
  }));
  const history = useAgent.getState().historyContext;
  // 发送这一刻打开的文件：每条都附，不进转写、不进「本轮引用来源」，界面上看不到
  const current = currentFileContext(l.root);
  void (async () => {
    const parts = [text];
    if (current) parts.push(current.text);
    if (history?.root === l.root) {
      parts.push(formatHistoryContext(history));
      if (archive) archive.record.continuedFrom = historySource(history);
      updateArchive();
    }
    // 引用来源是可打开的库内路径；应用数据目录里的历史档案不在其列
    const historySources = history?.root === l.root && !history.appData ? [history.path] : [];
    st({ contextSources: historySources, historyContext: null });
    baseId = await turnBaseline(l, turn);
    if (stale() || useApp.getState().lib?.root !== l.root || l.cancelling) return;
    return l.conn.prompt({ sessionId: l.sessionId!, prompt: parts.map((part) => ({ type: "text" as const, text: part })) });
  })()
    .finally(() => {
      if (!stale() && baseId) void finishTurn(l, turn, baseId, stale);
    })
    .then((r) => {
      if (stale()) return;
      st({ status: "ready" });
      if (!r || r.stopReason === "cancelled") info(t("已取消这一轮。"));
      else if (r.stopReason === "refusal") info(t("agent 拒绝继续这一轮。"));
      else if (r.stopReason === "max_tokens") info(t("这一轮到达 token 上限。"));
    })
    .catch((e) => {
      if (stale()) return;
      flushPermissions(l);
      const authFail = /authentication required|not logged in|unauthori[sz]ed/i.test(errMsg(e));
      const msg = authFail ? t("{0}——{1}", [errMsg(e), authHint()]) : errMsg(e);
      st((s) =>
        s.status === "exited" ? {} : { status: "error", error: msg },
      );
      info(t("这一轮失败：{0}", [msg]));
    });
}

export function cancelTurn(): void {
  const l = live;
  if (!l || l.sessionId === null) return;
  l.cancelling = true;
  // 规范要求：取消时挂起的权限请求必须以 cancelled 应答
  flushPermissions(l);
  void l.conn.cancel({ sessionId: l.sessionId });
}

export function resolvePermission(optionId: string | null): void {
  const l = live;
  if (!l) return;
  const q = l.permQueue.shift();
  if (!q) return;
  q.resolve(
    optionId === null
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId } },
  );
  st({ permission: l.permQueue[0]?.ask ?? null });
}

export function setSessionMode(modeId: string): void {
  const l = live;
  if (!l || l.sessionId === null) return;
  // 乐观更新；agent 的 current_mode_update 会再校正一次
  st((s) => (s.modes ? { modes: { ...s.modes, currentModeId: modeId } } : {}));
  l.conn.setSessionMode({ sessionId: l.sessionId, modeId }).catch((e) => {
    if (live !== l) return;
    info(t("切换模式失败：{0}", [errMsg(e)]));
  });
}

export async function stopSession(): Promise<boolean> {
  const l = live;
  live = null;
  genCounter++; // 旧回调全部作废
  if (l) flushPermissions(l);
  st({ status: "idle", permission: null });
  if (l) info(t("会话已结束。"));
  const [, saved] = await Promise.all([l?.proc.kill().catch(() => undefined), flushSessionArchive()]);
  if (!saved) st({ panelOpen: true, error: t("会话尚未保存，请重试保存。") });
  return saved;
}

/** Explicit history recovery: preserve the file, create a fresh ACP session, wait for user input. */
export async function startSessionFromHistory(path: string, appData = false): Promise<void> {
  const root = useApp.getState().lib?.root;
  if (!root) return;
  try {
    if (!await stopSession()) throw new Error(t("当前会话尚未保存，请重试保存后再载入历史。"));
    const historyContext = await readHistoryContext(backend, root, path, appData);
    if (useApp.getState().lib?.root !== root) return;
    st({ historyContext });
    await startSession();
  } catch (e) { if (useApp.getState().lib?.root === root) st({ error: errMsg(e) }); }
}

import.meta.hot?.dispose(() => {
  moduleActive = false;
  unsubscribeAgent();
  unsubscribeApp();
  void stopSession();
});
