/**
 * MCP server 的影子仓库定位与 git 操作层。
 *
 * 关键约束：MCP server 是独立进程，必须与桌面 app 共享**同一个**影子仓库，
 * 否则 agent 看不到人在 app 里打的快照。定位策略（按优先级）：
 *
 * 1. 精确命中：app_data/shadow/<sanitize(库名)-hash16>。hash16 = Rust
 *    `DefaultHasher`（SipHash-1-3，固定零 key，跨进程确定）对库根路径字符串
 *    的哈希，用 JS 实现；已有影子仓库按它定位，算法不能改，常量由 tests/mcp-shadow.test.ts 钉死。
 * 2. 扫描校验：遍历 app_data/shadow/* 与 ~/.openfile/dev-shadow/*（dev 桥），
 *    读各仓库 config 里的 core.worktree 与库根 realpath 比对（哈希实现漂移时的兜底）。
 * 3. 都没有：按第 1 条的路径初始化，
 *    app 之后打开同一文库会直接复用。
 *
 * 版本操作走 git 命令行（lib/git-bin.mjs：安装包自带的 git，否则 PATH 上的 git）。这里是快照的唯一写入者：
 * 桌面端经 sidecar、浏览器开发模式经 vite 中间件、MCP server 都调这一份（ShadowGit）。无 git 时版本工具优雅降级，
 * 读文件与审阅工具不受影响。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SKIP_DIRS, atomicWriteFile, canonicalRoot, readTextScoped, resolveScoped, resolveWritePathCreating } from "../lib/scoped.mjs";
import { SENSITIVE_PATH_PATTERNS, assertSafeSnapshotRestore, stageSafeSnapshot } from "../lib/sensitive-paths.mjs";
import { gitBinary, gitEnv } from "../lib/git-bin.mjs";

const execFileP = promisify(execFile);

/**
 * 影子仓库的每次 git 调用都带上：
 * Git for Windows 默认 core.autocrlf=true，会把 CRLF 文件改写成 LF 入库、还原时再改回——快照不再逐字节等于文库，
 * diff 也会整篇飘红；longpaths：深目录的文库在 Windows 上超过 260 字符。
 */
const SHADOW_GIT_CONFIG = ["-c", "core.autocrlf=false", "-c", "core.longpaths=true"];

/**
 * info/attributes 整体写成固定的一行（优先级高于树内 .gitattributes）：库里自带的 text / eol / ident /
 * filter / working-tree-encoding 都不许改写影子快照的字节。
 */
const SHADOW_ATTRIBUTES = "* -text -ident -filter -working-tree-encoding\n";
export function ensureShadowAttributes(gitDir: string): void {
  const file = path.join(gitDir, "info", "attributes");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SHADOW_ATTRIBUTES);
}

const MASK = 0xffffffffffffffffn;

function rotl(x: bigint, b: bigint): bigint {
  return ((x << b) | (x >> (64n - b))) & MASK;
}

/**
 * SipHash-1-3，key = (0,0)——即 Rust std `DefaultHasher::new()`。
 * 输入为原始字节流；`hashRustStr` 负责补 str Hash 的 0xff 终结符。
 */
function siphash13(data: Uint8Array): bigint {
  let v0 = 0x736f6d6570736575n;
  let v1 = 0x646f72616e646f6dn;
  let v2 = 0x6c7967656e657261n;
  let v3 = 0x7465646279746573n;

  const round = () => {
    v0 = (v0 + v1) & MASK;
    v1 = rotl(v1, 13n);
    v1 ^= v0;
    v0 = rotl(v0, 32n);
    v2 = (v2 + v3) & MASK;
    v3 = rotl(v3, 16n);
    v3 ^= v2;
    v0 = (v0 + v3) & MASK;
    v3 = rotl(v3, 21n);
    v3 ^= v0;
    v2 = (v2 + v1) & MASK;
    v1 = rotl(v1, 17n);
    v1 ^= v2;
    v2 = rotl(v2, 32n);
  };

  const len = data.length;
  const blocks = len - (len % 8);
  for (let i = 0; i < blocks; i += 8) {
    let m = 0n;
    for (let j = 7; j >= 0; j--) m = (m << 8n) | BigInt(data[i + j]);
    v3 ^= m;
    round();
    v0 ^= m;
  }
  // 尾块：余字节按小端放低位，长度低 8 位放最高字节（SipHash 规范）
  let last = (BigInt(len) & 0xffn) << 56n;
  for (let j = blocks; j < len; j++) {
    last |= BigInt(data[j]) << BigInt(8 * (j - blocks));
  }
  v3 ^= last;
  round();
  v0 ^= last;
  v2 ^= 0xffn;
  round();
  round();
  round();
  return (v0 ^ v1 ^ v2 ^ v3) & MASK;
}

/** Rust `str` 的 Hash 语义：utf8 字节 + 0xff 终结符；输出 {:016x} */
export function hashRustStr(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const data = new Uint8Array(bytes.length + 1);
  data.set(bytes);
  data[bytes.length] = 0xff;
  return siphash13(data).toString(16).padStart(16, "0");
}

/** 影子目录名里的库名：Unicode 字母数字保留，其余 `_`，取前 40 字符 */
export function sanitizeName(s: string): string {
  return [...s]
    .map((c) => (/[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u.test(c) ? c : "_"))
    .slice(0, 40)
    .join("");
}

const APP_ID = "com.wingsofsky.openfile";

/** Tauri app_data_dir 的各平台落点（OPENFILE_APPDATA 供测试改道，勿在生产设置） */
export function appDataDir(): string {
  if (process.env.OPENFILE_APPDATA) return process.env.OPENFILE_APPDATA;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", APP_ID);
  if (process.platform === "win32")
    return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), APP_ID);
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), APP_ID);
}

/**
 * git config 的值 → 原文（git config.c parse_value 的单行版）：去首尾空白、引号内空白原样、
 * `\\` `\"` `\n` `\t` `\b` 转义（引号内外都生效）、引号外 `#` `;` 起注释。非法转义 / 引号不闭合返回 null。
 * Windows 路径的反斜杠在 config 里是 `\\`——不反转义就拿 `D:\\库` 去 realpath，扫描兜底永远对不上。
 */
export function parseGitConfigValue(raw: string): string | null {
  let out = "";
  let quote = false;
  let trimAt = -1; // 引号外尾随空白的起点（遇到非空白就作废）
  for (let i = 0; i < raw.length; i++) {
    let c = raw[i];
    if (!quote && /\s/.test(c)) {
      if (trimAt < 0) trimAt = out.length;
      if (out.length) out += c;
      continue;
    }
    if (!quote && (c === "#" || c === ";")) break;
    trimAt = -1;
    if (c === "\\") {
      const n = raw[++i];
      if (n === "t") c = "\t";
      else if (n === "b") c = "\b";
      else if (n === "n") c = "\n";
      else if (n === "\\" || n === '"') c = n;
      else return null; // 未知转义 / 行尾续行（影子仓库的 config 不会这么写）
      out += c;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    out += c;
  }
  if (quote) return null;
  return trimAt >= 0 ? out.slice(0, trimAt) : out;
}

/** 从裸仓库的 config 文件里抠出 core.worktree（不依赖 git CLI；同键多次以最后一次为准，同 git） */
export function readWorktreeFromConfig(gitDir: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(gitDir, "config"), "utf-8");
  } catch {
    return null;
  }
  let inCore = false;
  let found: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inCore = line.replace(/\s/g, "").toLowerCase() === "[core]";
      continue;
    }
    if (!inCore) continue;
    const m = /^worktree\s*=(.*)$/i.exec(line);
    if (m) found = parseGitConfigValue(m[1]);
  }
  return found;
}

interface ShadowLocation {
  dir: string;
  kind: "app" | "dev" | "new";
}

/** 规范形式（canonicalRoot：Windows 原生 realpath、剥 `\\?\`），不可访问时原样 */
function canonicalOr(p: string): string {
  try {
    return canonicalRoot(p);
  } catch {
    return p;
  }
}

function sameLibrary(worktree: string | null, rootReal: string): boolean {
  if (!worktree) return false;
  try {
    // Rust 写进 config 的 worktree 可能带 `\\?\` 前缀；与 MCP / dev 桥的库根同一口径比较
    return canonicalRoot(worktree) === rootReal;
  } catch {
    return false;
  }
}

function scanFor(base: string, rootReal: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const name of entries) {
    const dir = path.join(base, name);
    if (!fs.existsSync(path.join(dir, "HEAD"))) continue;
    if (sameLibrary(readWorktreeFromConfig(dir), rootReal)) return dir;
  }
  return null;
}

/**
 * 定位已存在的影子仓库；找不到返回 null（不建）。
 * 目录名哈希的是库根的 canonicalRoot 形式（跨进程契约：Rust 侧哈希同一普通路径，不带 `\\?\`）。
 */
export function findShadowDir(root: string): ShadowLocation | null {
  const rootReal = canonicalOr(root);
  const appBase = path.join(appDataDir(), "shadow");
  const exact = path.join(appBase, `${sanitizeName(path.basename(rootReal))}-${hashRustStr(rootReal)}`);
  if (fs.existsSync(path.join(exact, "HEAD"))) return { dir: exact, kind: "app" };
  const appScan = scanFor(appBase, rootReal);
  if (appScan) return { dir: appScan, kind: "app" };
  const devBase = path.join(os.homedir(), ".openfile", "dev-shadow");
  const devScan = scanFor(devBase, rootReal);
  if (devScan) return { dir: devScan, kind: "dev" };
  return null;
}

async function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await execFileP(gitBinary(), args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: gitEnv(), ...opts });
  return stdout;
}

async function gitBuffer(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileP(gitBinary(), args, { maxBuffer: 2 * MAX_B64_CAP, windowsHide: true, env: gitEnv(), encoding: "buffer" });
  return stdout;
}

export async function hasGit(): Promise<boolean> {
  try {
    await git(["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** 初始化或校正影子仓库（每次打开都重写 worktree / exclude / attributes / autocrlf） */
export async function initShadowAt(dir: string, rootReal: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "HEAD"))) {
    await git([...SHADOW_GIT_CONFIG, "init", "--bare", "--initial-branch=main", dir]);
    await git([...SHADOW_GIT_CONFIG, "--git-dir", dir, "config", "core.bare", "false"]);
  }
  await git([...SHADOW_GIT_CONFIG, "--git-dir", dir, "config", "core.worktree", rootReal]);
  await git([...SHADOW_GIT_CONFIG, "--git-dir", dir, "config", "core.autocrlf", "false"]);
  fs.mkdirSync(path.join(dir, "info"), { recursive: true });
  const excl = [...SKIP_DIRS].map((d) => `${d}/`).concat([".DS_Store", "target/", "dist/", ...SENSITIVE_PATH_PATTERNS]);
  fs.writeFileSync(path.join(dir, "info", "exclude"), excl.join("\n") + "\n");
  ensureShadowAttributes(dir);
}

/** 桌面与 dev 共用的打开入口：已有的应用数据影子目录（精确命中或扫描）沿用，否则在精确位置新建；每次都校正配方 */
export async function openShadow(root: string): Promise<ShadowGit> {
  const rootReal = canonicalRoot(root);
  const found = findShadowDir(rootReal);
  const dir = found?.kind === "app"
    ? found.dir
    : path.join(appDataDir(), "shadow", `${sanitizeName(path.basename(rootReal))}-${hashRustStr(rootReal)}`);
  await initShadowAt(dir, rootReal);
  return new ShadowGit(dir, rootReal);
}

export interface SnapshotInfo {
  id: string;
  time: number;
  label: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "other";
}

interface DiffPair {
  old: string;
  new: string;
  oldBinary: boolean;
  newBinary: boolean;
}

/** 快照编号：十六进制前缀，可带 `~N`（父版）。只认这一种写法，挡住以 `-` 开头的参数注入 */
const REV_RE = /^[0-9a-f]{4,40}(~\d+)?$/i;
const DIFF_TEXT_CAP = 4 * 1024 * 1024;
/** base64 读取上限（前端 PdfView 按同值退回 asset 协议） */
export const MAX_B64_CAP = 32 * 1024 * 1024;

function checkRev(id: string): string {
  if (typeof id !== "string" || !REV_RE.test(id)) throw Object.assign(new Error("非法快照 id"), { status: 400 });
  return id;
}

/** git2 Blob::is_binary 的口径：前 8000 字节里有 NUL */
const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);
const utf8Lossy = (buf: Buffer) => new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, DIFF_TEXT_CAP));

/** 同一影子仓库的写操作（快照、还原）在本进程内排队；跨进程（MCP server 与桌面同时写）靠 index.lock 重试 */
const writeQueues = new Map<string, Promise<unknown>>();

/** 影子仓库上的版本操作（git 命令行，快照的唯一写入者） */
export class ShadowGit {
  readonly gitDir: string;
  readonly root: string;

  constructor(gitDir: string, root: string) {
    this.gitDir = gitDir;
    this.root = root;
  }

  private g(...args: string[]): Promise<string> {
    return git(this.base(args));
  }

  private base(args: string[]): string[] {
    // quotepath=false：中文等非 ASCII 文件名按原样输出（不做 C 风格八进制转义）；autocrlf/longpaths 见 SHADOW_GIT_CONFIG
    return [...SHADOW_GIT_CONFIG, "-c", "core.quotepath=false", "--git-dir", this.gitDir, "--work-tree", this.root, ...args];
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = writeQueues.get(this.gitDir) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    writeQueues.set(this.gitDir, tail);
    void tail.then(() => {
      if (writeQueues.get(this.gitDir) === tail) writeQueues.delete(this.gitDir);
    });
    return next;
  }

  async list(limit: number): Promise<SnapshotInfo[]> {
    let log: string;
    try {
      log = await this.g("log", "-n", String(limit), "--format=%H|%ct|%s");
    } catch {
      return []; // 尚无快照
    }
    const out: SnapshotInfo[] = [];
    for (const line of log.split("\n").filter(Boolean)) {
      const [sha, ct, ...rest] = line.split("|");
      let files = 0;
      let ins = 0;
      let del = 0;
      try {
        const stat = await this.g("diff-tree", "--no-commit-id", "--numstat", "--root", "-r", sha);
        for (const l of stat.split("\n").filter(Boolean)) {
          const [a, d] = l.split("\t");
          files++;
          ins += Number(a) || 0;
          del += Number(d) || 0;
        }
      } catch {
        /* 统计失败可忽略 */
      }
      out.push({
        id: sha.slice(0, 10),
        time: Number(ct),
        label: rest.join("|"),
        filesChanged: files,
        insertions: ins,
        deletions: del,
      });
    }
    return out;
  }

  /** 有变化则提交快照；无变化返回 null。index.lock 竞争（另一个进程同时在快照）重试一次 */
  snapshot(label: string): Promise<SnapshotInfo | null> {
    return this.exclusive(() => this.snapshotRetrying(label));
  }

  private async snapshotRetrying(label: string): Promise<SnapshotInfo | null> {
    try {
      return await this.snapshotOnce(label);
    } catch (e) {
      if (String(e).includes("index.lock")) {
        await new Promise((r) => setTimeout(r, 500));
        return this.snapshotOnce(label);
      }
      throw e;
    }
  }

  private async snapshotOnce(label: string): Promise<SnapshotInfo | null> {
    await stageSafeSnapshot((...args: string[]) => this.g(...args), this.root);
    try {
      await this.g("rev-parse", "--verify", "HEAD");
      try {
        await this.g("diff", "--cached", "--quiet");
        return null; // 无差异
      } catch {
        /* 有差异，提交 */
      }
    } catch {
      const st = await this.g("status", "--porcelain");
      if (!st.trim()) return null;
    }
    await this.g(
      "-c",
      "user.name=Openfile",
      "-c",
      "user.email=openfile@local",
      "commit",
      "-m",
      label || "快照",
    );
    const [info] = await this.list(1);
    return info ?? null;
  }

  /** 解析成提交的完整哈希；不存在抛「找不到该快照」 */
  private async commitOf(id: string): Promise<string> {
    checkRev(id);
    try {
      return (await this.g("rev-parse", "--verify", "--quiet", `${id}^{commit}`)).trim();
    } catch {
      throw Object.assign(new Error("找不到该快照"), { status: 404 });
    }
  }

  /** 某版本里一个文件的原始字节；该版本没有这个文件返回 null */
  private async blob(commit: string, rel: string): Promise<Buffer | null> {
    const spec = `${commit}:${rel.replaceAll("\\", "/")}`;
    let type: string;
    try {
      type = (await this.g("cat-file", "-t", spec)).trim();
    } catch {
      return null;
    }
    if (type !== "blob") return null;
    return gitBuffer(this.base(["cat-file", "blob", spec]));
  }

  /** from → id 的改动；from 省略 = 与 id 的父快照比（首个快照与空树比）。会话一轮的「轮前 → 轮后」用 from */
  async changes(id: string, from?: string): Promise<FileChange[]> {
    const to = await this.commitOf(id);
    const txt = from
      ? await this.g("diff-tree", "--name-status", "-r", await this.commitOf(from), to)
      : await this.g("diff-tree", "--no-commit-id", "--name-status", "--root", "-r", to);
    const out: FileChange[] = [];
    for (const l of txt.split("\n").filter(Boolean)) {
      const [st, ...rest] = l.split("\t");
      const status =
        st === "A" ? "added" : st === "M" ? "modified" : st === "D" ? "deleted" : st.startsWith("R") ? "renamed" : "other";
      out.push({ path: rest[rest.length - 1], status });
    }
    return out;
  }

  /** 单文件左右两侧：from 解析不到（如首个快照的父）按空文件；to 省略 = 工作区（走 scoped 出证），已删除按空文件 */
  async diffPair(rel: string, from: string, to?: string): Promise<DiffPair> {
    checkRev(from);
    let old = "";
    let oldBinary = false;
    const fromCommit = await this.commitOf(from).catch(() => null);
    const ob = fromCommit ? await this.blob(fromCommit, rel) : null;
    if (ob) {
      oldBinary = looksBinary(ob);
      old = oldBinary ? "" : utf8Lossy(ob);
    }
    let nu = "";
    let newBinary = false;
    if (to !== undefined && to !== null) {
      const nb = await this.blob(await this.commitOf(to), rel);
      if (nb) {
        newBinary = looksBinary(nb);
        nu = newBinary ? "" : utf8Lossy(nb);
      }
    } else {
      try {
        const t = (await readTextScoped(this.root, rel, DIFF_TEXT_CAP)) as { encoding: string; content: string };
        if (t.encoding === "binary") newBinary = true;
        else nu = t.content;
      } catch {
        /* 已删除或越界：空 */
      }
    }
    return { old, new: nu, oldBinary, newBinary };
  }

  /** 快照里一个文件的原始字节（docx 轮前基线）；该版本没有这个文件返回 null */
  async bytes(id: string, rel: string): Promise<Buffer | null> {
    const commit = await this.commitOf(id);
    const spec = `${commit}:${rel.replaceAll("\\", "/")}`;
    let size: number;
    try {
      if ((await this.g("cat-file", "-t", spec)).trim() !== "blob") return null;
      size = Number((await this.g("cat-file", "-s", spec)).trim());
    } catch {
      return null;
    }
    if (size > MAX_B64_CAP) throw new Error(`文件过大（>${MAX_B64_CAP / 1024 / 1024} MB）`);
    return gitBuffer(this.base(["cat-file", "blob", spec]));
  }

  /** 还原单个文件：先打安全快照（失败不阻断，同 Rust），再出证 + 建缺失父目录 + 原子写。返回安全快照（无变化为 null） */
  restoreFile(id: string, rel: string): Promise<SnapshotInfo | null> {
    return this.exclusive(async () => {
      assertSafeSnapshotRestore(this.root, rel);
      const safety = await this.snapshotRetrying("还原前自动快照").catch(() => null);
      const buf = await this.blob(await this.commitOf(id), rel);
      if (!buf) throw new Error("该版本中不存在此文件");
      atomicWriteFile(resolveWritePathCreating(this.root, rel), buf);
      return safety;
    });
  }

  /**
   * 整库还原到某快照（同 Rust checkout_tree force、不删未跟踪文件）：目标树里的文件写回，
   * 安全快照里有、目标树里没有的文件删掉；被排除的文件（凭据、node_modules……）不动。
   */
  restoreSnapshot(id: string): Promise<SnapshotInfo | null> {
    return this.exclusive(async () => {
      const commit = await this.commitOf(id);
      const targetPaths = (await this.g("ls-tree", "-r", "-z", "--name-only", commit)).split("\0").filter(Boolean);
      for (const rel of targetPaths) assertSafeSnapshotRestore(this.root, rel);
      const safety = await this.snapshotRetrying("还原前自动快照").catch(() => null);
      await this.g("checkout", commit, "--", ".");
      const target = new Set(targetPaths);
      let current: string[] = [];
      try {
        current = (await this.g("ls-tree", "-r", "-z", "--name-only", "HEAD")).split("\0").filter(Boolean);
      } catch {
        /* 还没有 HEAD */
      }
      for (const rel of current) {
        if (target.has(rel)) continue;
        try {
          // 删的是目录项本身：父目录出证，叶子不跟随符号链接（Node 24 Windows 上删单文件只用 unlinkSync）
          const parent = resolveScoped(this.root, path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel));
          const abs = path.join(parent, path.posix.basename(rel));
          const st = fs.lstatSync(abs);
          if (st.isFile() || st.isSymbolicLink()) fs.unlinkSync(abs);
        } catch {
          /* 已不在 */
        }
      }
      return safety;
    });
  }

  /** 快照 → 当前工作区的统一 diff（path 省略 = 全库） */
  async diffSince(id: string, rel?: string): Promise<string> {
    checkRev(id);
    const args = ["diff", "--no-color", id];
    if (rel !== undefined) args.push("--", rel);
    return this.g(...args);
  }
}
