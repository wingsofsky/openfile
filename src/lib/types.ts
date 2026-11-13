
export interface Entry {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
  mtime: number;
  ext: string;
}

/** 属性面板：叶子符号链接不解引用；目录的 size/items 为递归合计 */
export interface EntryInfo {
  name: string;
  rel: string;
  isDir: boolean;
  isSymlink: boolean;
  linkTarget: string | null;
  size: number;
  items: number | null;
  created: number | null;
  mtime: number;
  readonly: boolean;
  truncated: boolean;
}

export interface ImportReport {
  imported: string[];
  moved: Array<[string, string]>;
  skipped: Array<[string, string]>;
}

export interface LibraryInfo {
  root: string;
  name: string;
}

export interface RecentLibrary {
  root: string;
  name: string;
  exists: boolean;
}

export interface TextRead {
  content: string;
  size: number;
  truncated: boolean;
  encoding: string;
}

/** 应用数据目录里的一份内嵌会话档案 */
export interface ArchiveFile {
  name: string;
  size: number;
  mtime: number;
}

export interface BinaryRead {
  b64: string;
  size: number;
}

export interface SearchHit {
  rel: string;
  score: number;
}

export interface SnapshotInfo {
  id: string;
  time: number;
  label: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "other";
}

export interface DiffPair {
  old: string;
  new: string;
  oldBinary: boolean;
  newBinary: boolean;
}

/**
 * agent 适配器子进程的哑字节管道（协议无关）。
 * 运行时 api/processes.ts 只做 spawn + stdio 转发（桌面经 sidecar、dev 经 vite 中间件）；
 * ACP 协议唯一实现在 src/lib/agent-controller.ts。
 * 回调在进程退出后自动失效；同一事件可挂多个监听。
 */
export interface AgentProcessHandle {
  readonly id: number | string;
  /** 向 stdin 写字节（data 为 UTF-8 文本帧，ndjson 一帧一行） */
  write(data: string): Promise<void>;
  /** 合上 stdin 并终止进程（幂等） */
  kill(): Promise<void>;
  onStdout(cb: (bytes: Uint8Array) => void): void;
  onStderr(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

/**
 * 前端唯一的后端出入口。两个实现：
 * - TauriBackend：真身，invoke Rust 命令（生产与 `pnpm tauri dev`）
 * - RPC 后端：浏览器开发/E2E 用，经 vite 中间件（scripts/dev-runtime.mjs）调运行时 API（packages/runtime/src/api/）
 */
export interface Backend {
  readonly kind: "tauri" | "dev";
  getLibrary(): Promise<LibraryInfo | null>;
  setLibrary(path: string): Promise<LibraryInfo>;
  /** 弹系统目录选择器；用户取消返回 null（dev 实现退化为 prompt） */
  pickLibrary(): Promise<LibraryInfo | null>;
  /** 最近打开过的文库（最新在前） */
  getRecents(): Promise<RecentLibrary[]>;
  /** 当前索引状态：null = 正在建（补 index-ready 事件早于监听器的窗口） */
  getIndexCount(): Promise<number | null>;
  listDir(rel: string, expectedRoot?: string): Promise<Entry[]>;
  readText(rel: string, maxBytes?: number, expectedRoot?: string): Promise<TextRead>;
  /** scoped 原子写（编辑器保存 / 审阅接受拒绝落盘） */
  // expectedContent: undefined = ordinary write; null = create only; string = exact UTF-8 baseline.
  // The backend checks the captured library and serializes its own compare/write operations.
  writeText(rel: string, content: string, expectedRoot?: string, expectedContent?: string | null): Promise<void>;
  /**
   * 内嵌会话档案：文件夹是文库（根下有 .openfile/）时档案用 writeText 写进 会话/内嵌/；
   * 不是时走下面三个方法，存应用数据目录，不往文件夹里写。name 只能是会话控制器生成的「时间-UUID.md」。
   */
  archiveInLibrary(expectedRoot: string): Promise<boolean>;
  writeArchive(name: string, content: string, expectedRoot: string, expectedContent: string | null): Promise<void>;
  listArchives(expectedRoot: string): Promise<ArchiveFile[]>;
  readArchive(name: string, maxBytes: number | undefined, expectedRoot: string): Promise<TextRead>;
  statFile(rel: string): Promise<Entry>;
  /** 文件管理：全部按库内相对路径；返回新的 rel。永不覆盖已有项。 */
  createDir(dir: string, name: string, expectedRoot?: string): Promise<string>;
  renameEntry(rel: string, name: string, expectedRoot?: string): Promise<string>;
  moveEntry(rel: string, dir: string, expectedRoot?: string): Promise<string>;
  copyEntry(rel: string, dir: string, expectedRoot?: string): Promise<string>;
  trashEntry(rel: string, expectedRoot?: string): Promise<void>;
  entryInfo(rel: string, expectedRoot?: string): Promise<EntryInfo>;
  revealEntry(rel: string, expectedRoot?: string): Promise<void>;
  /**
   * 与系统之间搬文件（只有桌面端有；dev 桥为 null）。前端只给库内 rel / 库内目标目录，
   * 库外路径只由 Rust 从系统拖放事件 / 系统剪贴板取得。
   */
  transfer: null | {
    startDragOut(rels: string[], expectedRoot?: string): Promise<void>;
    copyFilesToClipboard(rels: string[], expectedRoot?: string): Promise<void>;
    importDropped(dir: string, expectedRoot?: string): Promise<ImportReport>;
    pasteClipboardFiles(dir: string, expectedRoot?: string): Promise<ImportReport>;
    /** 系统拖放事件（位置为 CSS 像素）；返回取消订阅 */
    onDragDrop(cb: (e: { type: "over" | "drop"; x: number; y: number } | { type: "leave" }) => void): () => void;
  };
  /** 当前系统用户名（批注作者署名用） */
  getUserName(): Promise<string>;
  readBinaryB64(rel: string): Promise<BinaryRead>;
  /** 文献 PDF 转 Markdown 笔记（本机 Docling）：`<名字>.pdf.md`，已有就沿用 */
  pdfToMarkdown(rel: string, expectedRoot?: string | null): Promise<{ rel: string; created: boolean; pages: number }>;
  /** HTML 转 Markdown 审阅稿：`<名字>.html.review.md`，已有就沿用；stale = HTML 比审阅稿新 */
  htmlToReview(rel: string, expectedRoot?: string | null): Promise<{ rel: string; created: boolean; stale: boolean }>;
  /** Word 往返：在 docx 旁建审阅稿（已有就沿用），返回审阅稿路径 */
  importDocx(rel: string, expectedRoot?: string | null): Promise<{ rel: string; created: boolean; hadMarkup: boolean }>;
  /** Word 往返：审阅稿写回成 `<名字>.reviewed.docx`（原生修订与批注），返回新文件路径 */
  exportDocx(reviewRel: string, expectedRoot?: string | null): Promise<{ rel: string; applied: number }>;
  searchFiles(q: string, limit?: number): Promise<SearchHit[]>;
  rebuildIndex(): Promise<void>;
  /** 库内相对路径 → 可直接给 <img>/<iframe> 的 URL（asset 协议或 dev 桥） */
  fileUrl(rel: string): string;
  onLibraryChanged(cb: (paths: string[]) => void): () => void;
  onIndexReady(cb: (count: number) => void): () => void;

  // ---- 版本层 ----
  /** 立即快照；无变化返回 null */
  snapshotNow(label?: string): Promise<SnapshotInfo | null>;
  listSnapshots(limit?: number): Promise<SnapshotInfo[]>;
  /** from 省略 = 与父快照比；给了 = from → id 之间的全部改动（中间隔着别的快照也算） */
  snapshotChanges(id: string, from?: string): Promise<FileChange[]>;
  /** to 省略 = 与当前工作区对比 */
  diffSnapshotFile(path: string, from: string, to?: string): Promise<DiffPair>;
  /** 快照里一个文件的原始字节（docx 等二进制的轮前基线）；该版本没有这个文件为 null */
  readSnapshotB64(id: string, path: string): Promise<BinaryRead | null>;
  restoreFile(id: string, path: string): Promise<void>;
  restoreSnapshot(id: string): Promise<void>;
  getAutoSnapshot(): Promise<boolean>;
  setAutoSnapshot(enabled: boolean): Promise<void>;
  onSnapshotCreated(cb: (info: SnapshotInfo) => void): () => void;

  // ---- 以 Openfile 打开 ----
  /** 取走操作系统交来的打开请求（双击文档、目录右键、openfile open、Finder）；dev 桥没有系统入口，永远为空 */
  takeOpenTargets(): Promise<OpenTarget[]>;
  /** 有新的打开请求时回调（随后调 takeOpenTargets 取）；返回取消订阅 */
  onOpenTarget(cb: () => void): () => void;
  /** 欢迎页拖入：把刚放到窗口上的文件 / 文件夹当「以 Openfile 打开」处理（路径由 Rust 暂存）；排上返回 true */
  openDropped(): Promise<boolean>;

  // ---- ACP 会话 ----
  /** spawn agent 适配器进程（cwd = 文库根）。文库未选时拒绝。 */
  spawnAgent(cmd: string, args: string[]): Promise<AgentProcessHandle>;
  /**
   * 会话要注入的 Openfile MCP server（stdio，--root 为当前文库）。
   * 文库已切换（≠ expectedRoot）时抛错；找不到 Node.js 时返回 null，会话照常开、只是没有 Openfile 工具。
   */
  agentMcpServer(expectedRoot: string): Promise<McpLaunch | null>;

  /**
   * 导出对话：把本机各家 CLI 的对话转成 Markdown，存进 Openfile 主文件夹（默认 ~/.openfile，不写当前文件夹）。
   * scope=folder 只导出在当前文件夹里干过活的对话（带 expectedRoot），all 导出本机全部。纯解析，不调模型、不联网
   */
  exportConversations(scope: "all" | "folder", expectedRoot?: string): Promise<ConversationExportResult>;
  /** Openfile 主文件夹的路径（没有就建好；对话档案在这里），可以当文库打开 */
  conversationsRoot(): Promise<string>;
}

/** 导出对话的结果：导出器打印的摘要（导出 / 刷新 / 跳过、脱敏统计）与档案库路径；ok=false 时 output 里是原因 */
export interface ConversationExportResult {
  ok: boolean;
  output: string;
  archiveRoot: string;
  /** 导出的数字（界面按当前语言组句）；认不出导出器的输出时为 null，只看 output */
  summary: {
    found: boolean;
    exported: number;
    refreshed: number;
    skipped: number;
    outside: number;
    redactions: number;
    suspects: number;
  } | null;
}

/** 以 Openfile 打开：推断出的工作区（当文库打开）与要打开的文档（open_target.rs） */
export interface OpenTarget {
  root: string;
  /** 库内相对路径；打开的是文件夹时为 null */
  rel: string | null;
}

/** 拉起 MCP server 的绝对命令与参数（交给 ACP session/new 的 mcpServers） */
export interface McpLaunch {
  command: string;
  args: string[];
}
