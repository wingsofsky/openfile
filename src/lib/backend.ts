import type {
  AgentProcessHandle,
  Backend,
  BinaryRead,
  Entry,
  LibraryInfo,
  SearchHit,
  SnapshotInfo,
  TextRead,
} from "./types";
import { bufferedChannel } from "./process-events";
import { isWindowsAbsPath, plainPath } from "./acp";

/**
 * 文库根 + 库内相对路径（`/` 分隔）→ 资源绝对路径。
 * Windows 根（盘符 / UNC / `\\?\` 前缀）：剥扩展前缀、统一反斜杠——`\\?\` 路径里 `/` 不是分隔符，
 * 混着拼出来的 `\\?\D:\库/图.png` 根本打不开；mac/Linux 原样 `${root}/${rel}`。
 */
export function libraryAbsPath(root: string, rel: string): string {
  if (!isWindowsAbsPath(root)) return `${root}/${rel}`;
  const base = plainPath(root).replace(/[\\/]+$/, "");
  return rel ? `${base}\\${rel.replace(/\//g, "\\")}` : `${base}\\`;
}

/**
 * convertFileSrc 尚未加载完的毫秒窗口里的兜底，按 Tauri 各平台的 asset 协议格式拼：
 * Windows 是 `http://asset.localhost/` + 整体 encodeURIComponent；macOS/Linux 逐段编码保留 `/`（不能整体编码，否则斜杠被吃）。
 */
export function assetUrlFallback(abs: string): string {
  if (isWindowsAbsPath(abs)) return `http://asset.localhost/${encodeURIComponent(abs)}`;
  const enc = abs.split("/").map(encodeURIComponent).join("/");
  return `asset://localhost/${enc}`;
}

/* ---- agent 管道的回调簿记（两个后端共用） ---- */
interface AgentSinks {
  stdout: ReturnType<typeof bufferedChannel<Uint8Array>>;
  stderr: ReturnType<typeof bufferedChannel<string>>;
  exit: ReturnType<typeof bufferedChannel<number | null>>;
  exited: boolean;
}
function newSinks(): AgentSinks {
  return { stdout: bufferedChannel<Uint8Array>(), stderr: bufferedChannel<string>(), exit: bufferedChannel<number | null>(), exited: false };
}
function fireExit(s: AgentSinks, code: number | null) {
  if (s.exited) return;
  s.exited = true;
  s.exit.emit(code);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/* ------------------------------------------------------------------ */
/* 运行时 RPC：浏览器 dev 经 vite /__rpc，桌面经 Rust 中继到 sidecar   */
/* ------------------------------------------------------------------ */

/** 运行时推来的事件（packages/runtime/src/api/workspace.ts 的 WorkspaceEvent，外加窗口编号） */
type RpcEvent =
  | { ws?: string; type: "library-changed"; paths: string[] }
  | { ws?: string; type: "index-ready"; count: number }
  | { ws?: string; type: "snapshot-created"; info: SnapshotInfo }
  | { ws?: string; type: "proc"; pid: string; stream: "stdout"; b64: string }
  | { ws?: string; type: "proc"; pid: string; stream: "stderr"; line: string }
  | { ws?: string; type: "proc"; pid: string; stream: "exit"; code: number | null };

/** 一种搬运方式：调方法 + 订阅本窗口的事件（ready 之后的事件保证送达） */
interface RpcTransport {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** 开始订阅；返回的 Promise 在事件通道接通后 resolve */
  listen(cb: (e: RpcEvent) => void): Promise<void>;
}

/** 只有宿主能做的事（系统对话框、废纸篓、拖放、剪贴板、打开入口、asset 协议） */
interface NativeOps {
  kind: Backend["kind"];
  setLibrary(path: string): Promise<LibraryInfo>;
  pickLibrary(): Promise<LibraryInfo | null>;
  trashEntry(rel: string, expectedRoot?: string): Promise<void>;
  revealEntry(rel: string, expectedRoot?: string): Promise<void>;
  transfer: Backend["transfer"];
  takeOpenTargets: Backend["takeOpenTargets"];
  onOpenTarget: Backend["onOpenTarget"];
  openDropped: Backend["openDropped"];
  fileUrl(root: string | null, rel: string): string;
}

/** 前端生成进程编号：spawn 之前接收端已登记，输出不会早于编号到达 */
function newPid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeRpcBackend(t: RpcTransport, native: NativeOps): Backend {
  let root: string | null = null;
  const remember = <T extends LibraryInfo | null>(info: T): T => {
    root = info?.root ?? null;
    return info;
  };
  const changedCbs = new Set<(paths: string[]) => void>();
  const indexCbs = new Set<(count: number) => void>();
  const snapCbs = new Set<(info: SnapshotInfo) => void>();
  const procs = new Map<string, AgentSinks>();

  let ready: Promise<void> | null = null;
  const ensureEvents = () => {
    ready ??= t.listen((e) => {
      if (e.type === "library-changed") changedCbs.forEach((cb) => cb(e.paths));
      else if (e.type === "index-ready") indexCbs.forEach((cb) => cb(e.count));
      else if (e.type === "snapshot-created") snapCbs.forEach((cb) => cb(e.info));
      else if (e.type === "proc") {
        const s = procs.get(e.pid);
        if (!s) return;
        if (e.stream === "stdout") s.stdout.emit(b64ToBytes(e.b64));
        else if (e.stream === "stderr") s.stderr.emit(e.line);
        else {
          procs.delete(e.pid);
          fireExit(s, e.code);
        }
      }
    }).catch((e) => {
      ready = null; // 下次再试
      throw e;
    });
    return ready;
  };
  const sub = <T>(set: Set<T>, cb: T) => {
    void ensureEvents().catch(() => undefined);
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };

  async function spawnProcess(method: string, params: Record<string, unknown>): Promise<AgentProcessHandle> {
    await ensureEvents();
    const pid = newPid();
    const sinks = newSinks();
    procs.set(pid, sinks);
    try {
      await t.call(method, { ...params, pid });
    } catch (e) {
      procs.delete(pid);
      throw e;
    }
    return {
      id: pid,
      write: (data) => t.call<void>("proc.write", { pid, data }),
      kill: () => t.call<void>("proc.kill", { pid }).catch(() => undefined),
      onStdout: (cb) => sinks.stdout.on(cb),
      onStderr: (cb) => sinks.stderr.on(cb),
      onExit: (cb) => sinks.exit.on(cb),
    } satisfies AgentProcessHandle;
  }

  return {
    kind: native.kind,
    getLibrary: async () => remember(await t.call<LibraryInfo | null>("library.get")),
    setLibrary: async (path) => remember(await native.setLibrary(path)),
    pickLibrary: async () => remember(await native.pickLibrary()),
    getRecents: () => t.call<import("./types").RecentLibrary[]>("library.recents"),
    getIndexCount: () => t.call<number | null>("index.count"),
    snapshotNow: (label) => t.call<SnapshotInfo | null>("snapshot.now", { label }),
    listSnapshots: (limit) => t.call<SnapshotInfo[]>("snapshot.list", { limit }),
    snapshotChanges: (id, from) => t.call<import("./types").FileChange[]>("snapshot.changes", { id, from }),
    diffSnapshotFile: (path, from, to) => t.call<import("./types").DiffPair>("snapshot.diffFile", { path, from, to }),
    readSnapshotB64: (id, path) => t.call<BinaryRead | null>("snapshot.readB64", { id, path }),
    restoreFile: (id, path) => t.call<void>("snapshot.restoreFile", { id, path }),
    restoreSnapshot: (id) => t.call<void>("snapshot.restore", { id }),
    getAutoSnapshot: () => t.call<boolean>("snapshot.getAuto"),
    setAutoSnapshot: (enabled) => t.call<void>("snapshot.setAuto", { enabled }),
    onSnapshotCreated: (cb) => sub(snapCbs, cb),
    listDir: (rel, expectedRoot) => t.call<Entry[]>("fs.list", { rel, expectedRoot }),
    readText: (rel, maxBytes, expectedRoot) => t.call<TextRead>("fs.readText", { rel, maxBytes, expectedRoot }),
    writeText: (rel, content, expectedRoot, expectedContent) =>
      t.call<void>("fs.write", {
        rel,
        content,
        expectedRoot,
        expectedContent: expectedContent === undefined ? undefined : { content: expectedContent },
      }),
    archiveInLibrary: (expectedRoot) => t.call<boolean>("archive.inLibrary", { expectedRoot }),
    writeArchive: (name, content, expectedRoot, expectedContent) =>
      t.call<void>("archive.write", { name, content, expectedRoot, expectedContent }),
    listArchives: (expectedRoot) => t.call<import("./types").ArchiveFile[]>("archive.list", { expectedRoot }),
    readArchive: (name, maxBytes, expectedRoot) => t.call<TextRead>("archive.read", { name, maxBytes, expectedRoot }),
    statFile: (rel) => t.call<Entry>("fs.stat", { rel }),
    createDir: (dir, name, expectedRoot) => t.call<string>("fileop.mkdir", { dir, name, expectedRoot }),
    renameEntry: (rel, name, expectedRoot) => t.call<string>("fileop.rename", { rel, name, expectedRoot }),
    moveEntry: (rel, dir, expectedRoot) => t.call<string>("fileop.move", { rel, dir, expectedRoot }),
    copyEntry: (rel, dir, expectedRoot) => t.call<string>("fileop.copy", { rel, dir, expectedRoot }),
    trashEntry: (rel, expectedRoot) => native.trashEntry(rel, expectedRoot),
    entryInfo: (rel, expectedRoot) => t.call<import("./types").EntryInfo>("fileop.info", { rel, expectedRoot }),
    revealEntry: (rel, expectedRoot) => native.revealEntry(rel, expectedRoot),
    transfer: native.transfer,
    exportConversations: (scope, expectedRoot) => t.call<import("./types").ConversationExportResult>("conversations.export", { scope, expectedRoot }),
    conversationsRoot: () => t.call<string>("conversations.root"),
    getUserName: () => t.call<string>("user.name").catch(() => "我"),
    readBinaryB64: (rel) => t.call<BinaryRead>("fs.readBinary", { rel }),
    pdfToMarkdown: (rel, expectedRoot) => t.call("pdf.toMarkdown", { rel, expectedRoot }),
    htmlToReview: (rel, expectedRoot) => t.call("html.toReview", { rel, expectedRoot }),
    importDocx: (rel, expectedRoot) => t.call("docx.import", { rel, expectedRoot }),
    exportDocx: (reviewRel, expectedRoot) => t.call("docx.export", { rel: reviewRel, expectedRoot }),
    searchFiles: (query, limit) => t.call<SearchHit[]>("index.search", { query, limit }),
    rebuildIndex: () => t.call<void>("index.rebuild"),
    fileUrl: (rel) => native.fileUrl(root, rel),
    onLibraryChanged: (cb) => sub(changedCbs, cb),
    onIndexReady: (cb) => sub(indexCbs, cb),
    spawnAgent: (cmd, args) => spawnProcess("proc.spawnAgent", { cmd, args }),
    takeOpenTargets: native.takeOpenTargets,
    onOpenTarget: native.onOpenTarget,
    openDropped: native.openDropped,
    agentMcpServer: (expectedRoot) => t.call<import("./types").McpLaunch | null>("agent.mcpServer", { expectedRoot }),
  };
}

/* ---- 浏览器 dev / E2E：vite 中间件（scripts/dev-runtime.mjs） ---- */

const DEV_HEADERS = { "content-type": "application/json", "x-openfile-request": "1" };

const devTransport: RpcTransport = {
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch("/__rpc", { method: "POST", headers: DEV_HEADERS, body: JSON.stringify({ method, params }) });
    const body = (await res.json().catch(() => null)) as { result?: T; error?: string } | null;
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body?.result as T;
  },
  listen(cb) {
    return new Promise((resolve, reject) => {
      const es = new EventSource("/__rpc/events");
      let opened = false;
      es.onopen = () => {
        opened = true;
        resolve();
      };
      es.onerror = () => {
        if (!opened && es.readyState === EventSource.CLOSED) reject(new Error("事件通道连接失败"));
      };
      es.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data) as RpcEvent;
          if ((e.ws ?? "main") === "main") cb(e);
        } catch {
          /* 心跳等非 JSON 帧 */
        }
      };
    });
  },
};

const devNative: NativeOps = {
  kind: "dev",
  setLibrary: (path) => devTransport.call<LibraryInfo>("library.open", { path }),
  async pickLibrary() {
    const path = window.prompt("dev 模式：输入文库目录的绝对路径");
    if (!path) return null;
    return devTransport.call<LibraryInfo>("library.open", { path });
  },
  trashEntry: (rel, expectedRoot) => devTransport.call<void>("fileop.trash", { rel, expectedRoot }),
  revealEntry: (rel, expectedRoot) => devTransport.call<void>("fileop.reveal", { rel, expectedRoot }),
  transfer: null,
  // 浏览器开发模式没有操作系统入口（双击 / 右键 / Finder），也拿不到拖入的真实路径
  takeOpenTargets: async () => [],
  onOpenTarget: () => () => {},
  openDropped: async () => false,
  fileUrl: (_root, rel) =>
    `/__fs/raw/${rel
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/")}`,
};


/* ---- 桌面：Rust 中继到 sidecar（src-tauri/src/sidecar.rs 的 rpc_call / rpc-event） ---- */

const core = () => import("@tauri-apps/api/core");

const tauriTransport: RpcTransport = {
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const { invoke } = await core();
    return invoke<T>("rpc_call", { method, params });
  },
  async listen(cb) {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const w = getCurrentWebviewWindow();
    // Rust 只把事件发给对应窗口（emit_to）；这里再按 ws 核一遍
    await w.listen<RpcEvent>("rpc-event", (e) => {
      if ((e.payload.ws ?? w.label) === w.label) cb(e.payload);
    });
  },
};

let convert: ((p: string) => string) | null = null;
if (hasTauri()) {
  void core().then((m) => {
    convert = m.convertFileSrc;
  });
}

/** 只有 Rust 能做的：系统对话框、废纸篓、在文件管理器中显示、拖放与剪贴板、打开入口、asset 协议 */
const tauriNative: NativeOps = {
  kind: "tauri",
  setLibrary: (path) => tauriTransport.call<LibraryInfo>("library.open", { path }),
  async pickLibrary() {
    const { invoke } = await core();
    return invoke<LibraryInfo | null>("pick_library");
  },
  async trashEntry(rel: string, expectedRoot?: string) {
    const { invoke } = await core();
    await invoke("trash_entry", { rel, expectedRoot });
  },
  async revealEntry(rel: string, expectedRoot?: string) {
    const { invoke } = await core();
    await invoke("reveal_entry", { rel, expectedRoot });
  },
  transfer: {
    async startDragOut(rels: string[], expectedRoot?: string) {
      const { invoke } = await core();
      await invoke("start_drag_out", { rels, expectedRoot });
    },
    async copyFilesToClipboard(rels: string[], expectedRoot?: string) {
      const { invoke } = await core();
      await invoke("copy_files_to_clipboard", { rels, expectedRoot });
    },
    async importDropped(dir: string, expectedRoot?: string) {
      const { invoke } = await core();
      return invoke<import("./types").ImportReport>("import_dropped", { destDir: dir, expectedRoot });
    },
    async pasteClipboardFiles(dir: string, expectedRoot?: string) {
      const { invoke } = await core();
      return invoke<import("./types").ImportReport>("paste_clipboard_files", { destDir: dir, expectedRoot });
    },
    onDragDrop(cb) {
      let un: (() => void) | null = null;
      let dead = false;
      void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((e) => {
          const p = e.payload;
          if (p.type === "leave") return cb({ type: "leave" });
          if (p.type !== "over" && p.type !== "drop") return;
          // Tauri 给的是物理像素
          const dpr = window.devicePixelRatio || 1;
          cb({ type: p.type, x: p.position.x / dpr, y: p.position.y / dpr });
        }).then((f) => {
          if (dead) f();
          else un = f;
        }),
      );
      return () => {
        dead = true;
        un?.();
      };
    },
  },
  async takeOpenTargets() {
    const { invoke } = await core();
    return invoke<import("./types").OpenTarget[]>("take_open_targets");
  },
  onOpenTarget(cb) {
    let un: (() => void) | null = null;
    let dead = false;
    // Rust 只发给主窗口（emit_to("main")）：按本窗口监听
    void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
      getCurrentWebviewWindow()
        .listen("open-target", () => cb())
        .then((f) => {
          if (dead) f();
          else un = f;
        }),
    );
    return () => {
      dead = true;
      un?.();
    };
  },
  async openDropped() {
    const { invoke } = await core();
    return invoke<boolean>("open_dropped");
  },
  fileUrl(root: string | null, rel: string) {
    if (!root) return "";
    const abs = libraryAbsPath(root, rel);
    if (convert) return convert(abs);
    return assetUrlFallback(abs);
  },
};

export const backend: Backend = hasTauri() ? makeRpcBackend(tauriTransport, tauriNative) : makeRpcBackend(devTransport, devNative);
