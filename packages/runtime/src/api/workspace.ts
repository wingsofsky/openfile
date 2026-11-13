/**
 * 一个打开的文库：根、文件索引、监听、影子快照（唯一写入者）、自动快照。会话进程归宿主的窗口槽位，切库不杀。
 * 桌面端每个窗口一个、浏览器开发模式一个。
 *
 * - 一切触盘经 scoped.mjs 出证；目录项操作经 file-ops.mjs 的 resolveEntry。
 * - 写入绑定 expectedRoot：调用方带上它看到的库根，库已切换就 409。
 * - 监听用 Node 原生 fs.watch(recursive)（不用 chokidar：5 万个文件的文库会 EMFILE），400ms 去抖后推 library-changed，3 秒后重建索引。
 * - 自动快照：文件变更后安静 45 秒打一次，15 秒检查一次；开关由宿主持有（settings.autoSnapshot）。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  SKIP_DIRS,
  SKIP_FILES,
  atomicWriteFile,
  canonicalRoot,
  readTextScoped,
  resolveScoped,
  resolveWritePathCreating,
} from "../lib/scoped.mjs";
import { DoclingMissingError, buildNotes, convertPdf, notesRelFor } from "../lib/pdf-markdown.ts";
import { DocxReviewError, docxRelFor, docxToReview, exportRelFor, reviewRelFor, reviewToDocx } from "../lib/docx-review.ts";
import { htmlReviewRelFor, htmlToMarkdown } from "../lib/html-review.ts";
import { ShadowGit, MAX_B64_CAP, openShadow, type SnapshotInfo } from "../mcp/shadow.ts";
import type { ProcEvent } from "./processes.ts";

export type WorkspaceEvent =
  | { type: "library-changed"; paths: string[] }
  | { type: "index-ready"; count: number }
  | { type: "snapshot-created"; info: SnapshotInfo }
  | ProcEvent;

interface Entry {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
  mtime: number;
  ext: string;
}

interface SearchHit {
  rel: string;
  score: number;
}

const MAX_INDEX = 400_000;
const AUTO_QUIET_MS = 45_000;
const AUTO_TICK_MS = 15_000;

export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

const extOf = (name: string, isDir: boolean) => {
  const i = name.lastIndexOf(".");
  return isDir || i <= 0 ? "" : name.slice(i + 1).toLowerCase();
};

/** Rust 的排序：目录在前，名称转小写后按码点比 */
const byName = (a: Entry, b: Entry) => {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

function isSubsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i >= needle.length) return true;
  }
  return needle.length === 0;
}

/** 与 Rust search_index 同口径：文件名前缀 0、文件名包含 1、路径包含 2、子序列 3；同分短路径优先 */
function searchIndex(index: string[], q: string, limit: number): SearchHit[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const hits: SearchHit[] = [];
  for (const rel of index) {
    const lower = rel.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number;
    if (name.startsWith(query)) score = 0;
    else if (name.includes(query)) score = 1;
    else if (lower.includes(query)) score = 2;
    else if (isSubsequence(lower, query)) score = 3;
    else continue;
    hits.push({ rel, score });
  }
  hits.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length);
  return hits.slice(0, limit);
}

/** 同步比较 + 写：事件循环里不会插进切库或另一笔写入。外部 CLI 仍可能独立改文件，这不是文件系统级锁 */
export function writeTextBound(
  root: string,
  rel: string,
  content: string,
  expectedRoot?: string | null,
  expectedContent?: { content: string | null },
): void {
  if (expectedRoot !== undefined && expectedRoot !== null && expectedRoot !== root) {
    throw httpError(409, "文库已切换，请回到原文库后重试。");
  }
  if (expectedContent !== undefined) {
    if (!expectedContent || !(expectedContent.content === null || typeof expectedContent.content === "string")) {
      throw httpError(400, "非法写入基线");
    }
    if (expectedContent.content !== null) {
      const current = fs.readFileSync(resolveScoped(root, rel));
      if (!current.equals(Buffer.from(expectedContent.content, "utf8"))) {
        throw httpError(409, "文件已更改，未覆盖。请刷新后重试。");
      }
    }
  }
  const target = resolveWritePathCreating(root, rel);
  if (expectedContent?.content === null) {
    let exists = false;
    try {
      fs.lstatSync(target);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) throw httpError(409, "文件已存在，未覆盖。");
  }
  atomicWriteFile(target, content);
}

function boundRoot(root: string, expectedRoot?: string | null): void {
  if (expectedRoot !== undefined && expectedRoot !== null && expectedRoot !== root) {
    throw httpError(409, "文库已切换，请回到原文库后重试。");
  }
}

function capSize(size: number): void {
  if (size > MAX_B64_CAP) throw httpError(413, `文件过大（>${MAX_B64_CAP / 1024 / 1024} MB）`);
}

/** Word 往返·导入：在 docx 旁边建审阅稿；已经有了就沿用（接着审），不覆盖 */
export async function importDocxBound(
  root: string,
  rel: string,
  expectedRoot?: string | null,
): Promise<{ rel: string; created: boolean; hadMarkup: boolean }> {
  boundRoot(root, expectedRoot);
  if (!/\.docx$/i.test(rel)) throw httpError(400, "只支持 .docx");
  const abs = resolveScoped(root, rel);
  capSize(fs.statSync(abs).size);
  const reviewRel = reviewRelFor(rel);
  if (fs.existsSync(resolveWritePathCreating(root, reviewRel))) return { rel: reviewRel, created: false, hadMarkup: false };
  const { text, hadMarkup } = await docxToReview(fs.readFileSync(abs));
  writeTextBound(root, reviewRel, text, expectedRoot, { content: null });
  return { rel: reviewRel, created: true, hadMarkup };
}

/** Word 往返·导出：审阅稿写回 docx 的副本 `<名字>.reviewed.docx`，永不覆盖原件与已有导出 */
export async function exportDocxBound(
  root: string,
  reviewRel: string,
  author: string,
  expectedRoot?: string | null,
): Promise<{ rel: string; applied: number }> {
  boundRoot(root, expectedRoot);
  const docxRel = docxRelFor(reviewRel);
  if (!docxRel) throw httpError(400, "这不是 Word 审阅稿（应以 .docx.review.md 结尾）");
  const docxAbs = resolveScoped(root, docxRel);
  capSize(fs.statSync(docxAbs).size);
  const { content, truncated } = await readTextScoped(root, reviewRel, MAX_B64_CAP);
  if (truncated) throw httpError(413, "审阅稿过大");
  let result: { bytes: Uint8Array; applied: number };
  try {
    result = await reviewToDocx(fs.readFileSync(docxAbs), content, author);
  } catch (e) {
    if (e instanceof DocxReviewError) throw httpError(422, e.message);
    throw e;
  }
  const outRel = exportRelFor(docxRel, (r) => fs.existsSync(resolveWritePathCreating(root, r)));
  atomicWriteFile(resolveWritePathCreating(root, outRel), Buffer.from(result.bytes));
  return { rel: outRel, applied: result.applied };
}

/** 文献 PDF → Markdown 笔记：`<名字>.pdf.md` 放在 PDF 旁边；已有就沿用，不覆盖 */
export async function pdfToMarkdownBound(
  root: string,
  rel: string,
  expectedRoot?: string | null,
): Promise<{ rel: string; created: boolean; pages: number }> {
  boundRoot(root, expectedRoot);
  if (!/\.pdf$/i.test(rel)) throw httpError(400, "只支持 .pdf");
  const abs = resolveScoped(root, rel);
  const notesRel = notesRelFor(rel);
  if (fs.existsSync(resolveWritePathCreating(root, notesRel))) return { rel: notesRel, created: false, pages: 0 };
  let pages: Array<{ page: number; md: string }>;
  try {
    pages = await convertPdf(abs);
  } catch (e) {
    if (e instanceof DoclingMissingError) throw httpError(424, e.message);
    throw httpError(500, (e as Error).message);
  }
  writeTextBound(root, notesRel, buildNotes(path.basename(rel), pages), expectedRoot, { content: null });
  return { rel: notesRel, created: true, pages: pages.length };
}

/**
 * HTML 审阅稿：`<名字>.html.review.md` 放在 HTML 旁边；已有就沿用，不覆盖。
 * stale：HTML 在审阅稿之后又改过（多半是 agent 按上一轮意见改完了），要不要删旧稿重转由人定。
 */
export async function htmlToReviewBound(
  root: string,
  rel: string,
  expectedRoot?: string | null,
): Promise<{ rel: string; created: boolean; stale: boolean }> {
  boundRoot(root, expectedRoot);
  if (!/\.html?$/i.test(rel)) throw httpError(400, "只支持 .html / .htm");
  const abs = resolveScoped(root, rel);
  const reviewRel = htmlReviewRelFor(rel);
  const reviewAbs = resolveWritePathCreating(root, reviewRel);
  if (fs.existsSync(reviewAbs)) {
    const stale = fs.statSync(abs).mtimeMs > fs.statSync(reviewAbs).mtimeMs;
    return { rel: reviewRel, created: false, stale };
  }
  const { content, truncated } = await readTextScoped(root, rel, MAX_B64_CAP);
  if (truncated) throw httpError(413, "HTML 过大");
  writeTextBound(root, reviewRel, await htmlToMarkdown(content), expectedRoot, { content: null });
  return { rel: reviewRel, created: true, stale: false };
}

interface WorkspaceOptions {
  emit: (e: WorkspaceEvent) => void;
  autoSnapshot: () => boolean;
}

export class Workspace {
  readonly root: string;
  readonly name: string;
  private index: string[] = [];
  private indexing = false;
  private indexDirty = false;
  private closed = false;
  private watcher: fs.FSWatcher | null = null;
  private pending = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private reindexTimer: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private lastChange = 0;
  private lastConsumed = 0;
  private shadowP: Promise<ShadowGit> | null = null;

  private opts: WorkspaceOptions;

  private constructor(root: string, opts: WorkspaceOptions) {
    this.opts = opts;
    this.root = root;
    this.name = path.basename(root) || "文库";
  }

  /** 规范化、校验是目录、先起监听（失败则不挂载），再建索引与影子仓库 */
  static open(dir: string, opts: WorkspaceOptions): Workspace {
    let root: string;
    try {
      root = canonicalRoot(dir);
    } catch (e) {
      throw httpError(400, `路径不可访问: ${(e as Error).message}`);
    }
    if (!fs.statSync(root).isDirectory()) throw httpError(400, "不是目录");
    const ws = new Workspace(root, opts);
    ws.startWatcher();
    void ws.buildIndex();
    ws.shadow().catch((e) => console.error(`[openfile] 影子仓库不可用: ${(e as Error).message}`));
    ws.ticker = setInterval(() => ws.autoTick(), AUTO_TICK_MS);
    ws.ticker.unref?.();
    return ws;
  }

  info() {
    return { root: this.root, name: this.name };
  }

  /** expectedRoot 给了就必须是本库；undefined = 调用方没绑定 */
  bound(expectedRoot: unknown): string {
    if (expectedRoot !== undefined && expectedRoot !== null && expectedRoot !== this.root) {
      throw httpError(409, "文库已切换，请回到原文库后重试。");
    }
    return this.root;
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    for (const t of [this.flushTimer, this.reindexTimer, this.ticker]) if (t) clearTimeout(t);
  }

  /* ---------------- 读写 ---------------- */

  async list(rel: string): Promise<Entry[]> {
    const abs = resolveScoped(this.root, rel);
    if (!fs.statSync(abs).isDirectory()) throw httpError(400, "不是目录");
    const ents = await fsp.readdir(abs, { withFileTypes: true });
    const out: Entry[] = [];
    for (const ent of ents) {
      let isDir = ent.isDirectory();
      let st: fs.Stats;
      try {
        if (ent.isSymbolicLink()) {
          // 解链后不在库内（逃逸或悬空）的符号链接彻底不展示，防库外目标的元数据 / 存在性 oracle；库内链接按目标算
          const real = await fsp.realpath(path.join(abs, ent.name));
          if (!real.startsWith(this.root + path.sep)) continue;
          st = await fsp.stat(real);
          isDir = st.isDirectory();
        } else {
          st = await fsp.stat(path.join(abs, ent.name));
        }
      } catch {
        continue;
      }
      if (isDir && SKIP_DIRS.has(ent.name)) continue;
      if (!isDir && SKIP_FILES.has(ent.name)) continue;
      out.push({
        name: ent.name,
        rel: rel ? `${rel}/${ent.name}` : ent.name,
        isDir,
        size: st.size,
        mtime: Math.floor(st.mtimeMs / 1000),
        ext: extOf(ent.name, isDir),
      });
    }
    return out.sort(byName);
  }

  readText(rel: string, maxBytes?: number) {
    return readTextScoped(this.root, rel, maxBytes);
  }

  async readBinary(rel: string): Promise<{ b64: string; size: number }> {
    const abs = resolveScoped(this.root, rel);
    const st = await fsp.stat(abs);
    if (st.size > MAX_B64_CAP) throw httpError(413, `文件过大（>${MAX_B64_CAP / 1024 / 1024} MB）`);
    const buf = await fsp.readFile(abs);
    return { b64: buf.toString("base64"), size: st.size };
  }

  async stat(rel: string): Promise<Entry> {
    const abs = resolveScoped(this.root, rel);
    const st = await fsp.stat(abs);
    const name = path.basename(abs);
    return { name, rel, isDir: st.isDirectory(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000), ext: extOf(name, st.isDirectory()) };
  }

  write(rel: string, content: string, expectedRoot?: string | null, expectedContent?: { content: string | null }): void {
    writeTextBound(this.root, rel, content, expectedRoot, expectedContent);
  }

  importDocx(rel: string, expectedRoot?: string | null) {
    return importDocxBound(this.root, rel, expectedRoot);
  }

  exportDocx(reviewRel: string, author: string, expectedRoot?: string | null) {
    return exportDocxBound(this.root, reviewRel, author, expectedRoot);
  }

  pdfToMarkdown(rel: string, expectedRoot?: string | null) {
    return pdfToMarkdownBound(this.root, rel, expectedRoot);
  }

  htmlToReview(rel: string, expectedRoot?: string | null) {
    return htmlToReviewBound(this.root, rel, expectedRoot);
  }

  /* ---------------- 索引 ---------------- */

  search(q: string, limit: number): SearchHit[] {
    return searchIndex(this.index, q, limit);
  }

  indexCount(): number | null {
    return this.indexing && this.index.length === 0 ? null : this.index.length;
  }

  async buildIndex(): Promise<void> {
    if (this.closed) return;
    if (this.indexing) {
      // 构建中来了新请求：置脏，收尾后补一轮
      this.indexDirty = true;
      return;
    }
    this.indexing = true;
    const out: string[] = [];
    const queue = [""];
    try {
      while (queue.length > 0 && out.length < MAX_INDEX) {
        const rel = queue.shift()!;
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(path.join(this.root, rel), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of entries) {
          const childRel = rel ? `${rel}/${ent.name}` : ent.name;
          if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) queue.push(childRel);
          } else if (ent.isFile()) {
            out.push(childRel);
          } else if (ent.isSymbolicLink()) {
            // 只收「解析后仍在库内且指向普通文件」的符号链接；目录链接不入队（防环），打开时仍会复验
            try {
              const real = await fsp.realpath(path.join(this.root, childRel));
              if (real.startsWith(this.root + path.sep) && (await fsp.stat(real)).isFile()) out.push(childRel);
            } catch {
              /* 悬空 */
            }
          }
        }
      }
    } finally {
      if (!this.closed) {
        this.index = out;
        this.opts.emit({ type: "index-ready", count: out.length });
      }
      this.indexing = false;
      if (this.indexDirty) {
        this.indexDirty = false;
        void this.buildIndex();
      }
    }
  }

  private startWatcher(): void {
    this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join("/");
      if (!rel || rel.startsWith("..") || rel.split("/").some((seg) => SKIP_DIRS.has(seg))) return;
      this.pending.add(rel);
      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const paths = [...this.pending];
        this.pending = new Set();
        this.opts.emit({ type: "library-changed", paths });
        this.lastChange = Date.now();
        if (!this.reindexTimer) {
          this.reindexTimer = setTimeout(() => {
            this.reindexTimer = null;
            void this.buildIndex();
          }, 3000);
        }
      }, 400);
    });
    // 瞬态错误（如目录消失）不能让宿主崩
    this.watcher.on("error", (e) => console.error(`[openfile] 监听: ${e.message}`));
  }

  /* ---------------- 快照 ---------------- */

  shadow(): Promise<ShadowGit> {
    this.shadowP ??= openShadow(this.root);
    this.shadowP.catch(() => {
      this.shadowP = null; // 失败可重试
    });
    return this.shadowP;
  }

  async snapshot(label?: string): Promise<SnapshotInfo | null> {
    const info = await (await this.shadow()).snapshot(label || "快照");
    if (info) this.opts.emit({ type: "snapshot-created", info });
    return info;
  }

  async restoreFile(id: string, rel: string): Promise<void> {
    const safety = await (await this.shadow()).restoreFile(id, rel);
    if (safety) this.opts.emit({ type: "snapshot-created", info: safety });
  }

  async restoreSnapshot(id: string): Promise<void> {
    const safety = await (await this.shadow()).restoreSnapshot(id);
    if (safety) this.opts.emit({ type: "snapshot-created", info: safety });
  }

  private autoTick(): void {
    if (this.closed || !this.opts.autoSnapshot()) return;
    if (this.lastChange === 0 || this.lastChange <= this.lastConsumed) return;
    if (Date.now() - this.lastChange < AUTO_QUIET_MS) return;
    this.lastConsumed = this.lastChange;
    this.snapshot("自动快照").catch((e) => console.error(`[openfile] 自动快照失败: ${(e as Error).message}`));
  }
}
