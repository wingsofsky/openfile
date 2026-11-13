import { create } from "zustand";
import { backend } from "../lib/backend";
import type { LibraryInfo } from "../lib/types";
import { t } from "../i18n";
import { prefs } from "../lib/prefs";

/** 文库根的比较口径：分隔符统一，Windows 盘符路径 / UNC 不分大小写 */
const rootKey = (root: string) => {
  const s = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(s) || s.startsWith("//") ? s.toLowerCase() : s;
};

type Theme = "paper" | "ink";

export interface DiffPayload {
  path: string;
  from: string;
  /** 省略 = 对比当前工作区 */
  to?: string;
  fromLabel?: string;
}

interface Tab {
  /** 普通文件 tab = rel 路径；特殊页用前缀（spike:ime / diff:…） */
  id: string;
  rel: string;
  kind: "file" | "spike" | "diff";
  diff?: DiffPayload;
  /** 打开后要滚到的锚：md 阅读模式的标题 id，PDF 的 `page=N` */
  anchor?: string;
}

interface AppState {
  lib: LibraryInfo | null;
  libLoading: boolean;
  indexCount: number | null;
  tabs: Tab[];
  activeId: string | null;
  theme: Theme;
  fontScale: number;
  /** 最近一批变更（时间戳驱动订阅方刷新） */
  changed: { paths: string[]; ts: number } | null;
  quickOpenVisible: boolean;
  timelineOpen: boolean;
  /** 左侧文库栏是否收起（记在 localStorage） */
  railCollapsed: boolean;
  /** 两侧栏宽度（px，可拖；记在 localStorage） */
  railWidth: number;
  agentWidth: number;
  /** 快照创建事件计数（驱动时间线刷新） */
  snapshotTick: number;
  /** 状态栏上的一句说明（以 Openfile 打开没能完成），点一下关掉 */
  openNotice: string | null;
  dismissOpenNotice(): void;
  /** 处理操作系统交来的打开请求：工作区不是当前文库就先切过去，再开文档 */
  drainOpenTargets(): Promise<void>;

  init(): Promise<void>;
  toggleTimeline(): void;
  toggleRail(): void;
  /** persist=false 给拖动过程用（每帧都写 localStorage 没必要），松手时再落一次 */
  setPanelWidth(which: "rail" | "agent", px: number, persist?: boolean): void;
  openDiff(payload: DiffPayload): void;
  refreshIndexCount(): Promise<void>;
  chooseLibrary(): Promise<void>;
  setLibraryPath(path: string): Promise<void>;
  openFile(rel: string, anchor?: string): void;
  openSpike(): void;
  closeTab(id: string): void;
  /** 文件/目录改名或移动后：把它自己与其下所有文件 tab 指到新路径 */
  retargetTabs(from: string, to: string): void;
  /** 文件/目录移到废纸篓后：关掉它自己与其下所有文件 tab */
  closeTabsUnder(rel: string): void;
  setActive(id: string): void;
  toggleTheme(): void;
  adjustFont(delta: number): void;
  setQuickOpen(v: boolean): void;
}

const THEME_KEY = "openfile:theme";
const FONT_KEY = "openfile:fontScale";
const RAIL_KEY = "openfile:railCollapsed";
const RAIL_W_KEY = "openfile:railWidth";
const AGENT_W_KEY = "openfile:agentWidth";

/** 侧栏宽度的默认值与夹取范围（拖动手柄、键盘调整、读 localStorage 共用） */
export const PANEL_WIDTH = {
  rail: { def: 272, min: 180, max: 520 },
  agent: { def: 380, min: 300, max: 760 },
} as const;

function clampPanelWidth(which: "rail" | "agent", px: number): number {
  const { def, min, max } = PANEL_WIDTH[which];
  if (!Number.isFinite(px)) return def;
  return Math.round(Math.min(max, Math.max(min, px)));
}

function prefersDark(): boolean {
  try {
    return !!globalThis.window?.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  } catch {
    return false;
  }
}

function initialTheme(): Theme {
  const stored = prefs.get(THEME_KEY);
  if (stored === "paper" || stored === "ink") return stored;
  return prefersDark() ? "ink" : "paper";
}

function initialFontScale(): number {
  const v = Number(prefs.get(FONT_KEY));
  if (!Number.isFinite(v) || v === 0) return 1;
  return Math.min(1.4, Math.max(0.85, v)); // 夹取被篡改/旧值
}

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  prefs.set(THEME_KEY, t);
}

/** 后端事件订阅只做一次（模块级，跨 StrictMode 双挂载与重复 init 幂等） */
let subscribed = false;

export const useApp = create<AppState>((set, get) => ({
  lib: null,
  libLoading: true,
  indexCount: null,
  tabs: [],
  activeId: null,
  theme: initialTheme(),
  fontScale: initialFontScale(),
  changed: null,
  quickOpenVisible: false,
  timelineOpen: false,
  railCollapsed: prefs.get(RAIL_KEY) === "1",
  railWidth: clampPanelWidth("rail", Number(prefs.get(RAIL_W_KEY) ?? NaN)),
  agentWidth: clampPanelWidth("agent", Number(prefs.get(AGENT_W_KEY) ?? NaN)),
  snapshotTick: 0,
  openNotice: null,
  dismissOpenNotice: () => set({ openNotice: null }),

  async drainOpenTargets() {
    const targets = await Promise.resolve().then(() => backend.takeOpenTargets()).catch(() => []);
    // 一次只开一个工作区：连着来几个请求，以最后一个为准
    const target = targets.at(-1);
    if (!target) return;
    try {
      const cur = get().lib?.root;
      if (!cur || rootKey(cur) !== rootKey(target.root)) await get().setLibraryPath(target.root);
      if (target.rel) {
        get().openFile(target.rel);
        // 树里展开到这份文档（行随活动标签高亮）。files.ts 在模块初始化时就订阅本 store，只能动态取
        const { useFiles } = await import("./files");
        useFiles.setState({ expand: { rel: target.rel, ts: Date.now() } });
      }
      set({ openNotice: null });
    } catch (e) {
      set({ openNotice: t("没能打开 {0}：{1}", [target.rel ?? target.root, e instanceof Error ? e.message : String(e)]) });
    }
  },

  async init() {
    applyTheme(get().theme);
    // 只订阅一次（StrictMode 双调用 / 重复 init 不再叠加监听，防泄漏）
    if (!subscribed) {
      subscribed = true;
      backend.onLibraryChanged((paths) => set({ changed: { paths, ts: Date.now() } }));
      backend.onIndexReady((count) => set({ indexCount: count }));
      backend.onSnapshotCreated(() => set((s) => ({ snapshotTick: s.snapshotTick + 1 })));
      backend.onOpenTarget(() => void get().drainOpenTargets());
    }
    try {
      const lib = await backend.getLibrary();
      set({ lib, libLoading: false });
      if (lib) {
        // 主动拉取索引状态：index-ready 事件可能在监听器挂载前已发出（小库瞬间建完）
        const count = await backend.getIndexCount().catch(() => null);
        if (count !== null) set({ indexCount: count });
      }
    } catch {
      set({ libLoading: false });
    }
    // 首次启动带来的打开请求（双击文档启动）在前端起来前就排上了
    void get().drainOpenTargets();
  },

  /** 切库后轮询兜底：事件若丢失，2s 后主动查一次 */
  async refreshIndexCount() {
    const count = await backend.getIndexCount().catch(() => null);
    if (count !== null) set({ indexCount: count });
  },

  async chooseLibrary() {
    const { stopSession } = await import("../lib/agent-controller");
    if (!await stopSession()) throw new Error(t("会话尚未保存，请在会话面板重试保存后再切换文库。"));
    const lib = await backend.pickLibrary();
    if (lib) {
      set({ lib, tabs: [], activeId: null, indexCount: null });
      setTimeout(() => void get().refreshIndexCount(), 2000);
    }
  },

  async setLibraryPath(path: string) {
    const { stopSession } = await import("../lib/agent-controller");
    if (!await stopSession()) throw new Error(t("会话尚未保存，请在会话面板重试保存后再切换文库。"));
    const lib = await backend.setLibrary(path);
    set({ lib, tabs: [], activeId: null, indexCount: null });
    setTimeout(() => void get().refreshIndexCount(), 2000);
  },

  openFile(rel: string, anchor?: string) {
    const { tabs } = get();
    const existing = tabs.find((t) => t.id === rel);
    if (existing) {
      // 锚点每次覆盖（无锚打开清掉旧锚，防止旧跳转重放）
      set({
        tabs: tabs.map((t) => (t.id === rel ? { ...t, anchor } : t)),
        activeId: existing.id,
      });
      return;
    }
    set({ tabs: [...tabs, { id: rel, rel, kind: "file", anchor }], activeId: rel });
  },

  openSpike() {
    const { tabs } = get();
    if (!tabs.find((t) => t.id === "spike:ime")) {
      set({ tabs: [...tabs, { id: "spike:ime", rel: "", kind: "spike" }] });
    }
    set({ activeId: "spike:ime" });
  },


  closeTab(id: string) {
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const next = tabs.filter((t) => t.id !== id);
    let nextActive = activeId;
    if (activeId === id) {
      nextActive = next[Math.min(idx, next.length - 1)]?.id ?? null;
    }
    set({ tabs: next, activeId: nextActive });
  },

  retargetTabs(from: string, to: string) {
    const { tabs, activeId } = get();
    const map = (rel: string) =>
      rel === from ? to : rel.startsWith(from + "/") ? to + rel.slice(from.length) : null;
    let nextActive = activeId;
    const seen = new Set<string>();
    const next: Tab[] = [];
    for (const t of tabs) {
      const moved = t.kind === "file" ? map(t.rel) : null;
      const tab = moved === null ? t : { ...t, id: moved, rel: moved };
      if (seen.has(tab.id)) continue; // 目标路径已有 tab：并掉
      seen.add(tab.id);
      if (t.id === activeId) nextActive = tab.id;
      next.push(tab);
    }
    set({ tabs: next, activeId: nextActive });
  },

  closeTabsUnder(rel: string) {
    const doomed = get()
      .tabs.filter((t) => t.kind === "file" && (t.rel === rel || t.rel.startsWith(rel + "/")))
      .map((t) => t.id);
    for (const id of doomed) get().closeTab(id);
  },

  setActive(id: string) {
    set({ activeId: id });
  },

  toggleTheme() {
    const t: Theme = get().theme === "paper" ? "ink" : "paper";
    applyTheme(t);
    set({ theme: t });
  },

  adjustFont(delta: number) {
    const v = Math.min(1.4, Math.max(0.85, get().fontScale + delta));
    prefs.set(FONT_KEY, String(v));
    set({ fontScale: v });
  },

  setQuickOpen(v: boolean) {
    set({ quickOpenVisible: v });
  },

  toggleTimeline() {
    set((s) => ({ timelineOpen: !s.timelineOpen }));
  },

  setPanelWidth(which, px, persist = true) {
    const v = clampPanelWidth(which, px);
    if (persist) prefs.set(which === "rail" ? RAIL_W_KEY : AGENT_W_KEY, String(v));
    set(which === "rail" ? { railWidth: v } : { agentWidth: v });
  },

  toggleRail() {
    const v = !get().railCollapsed;
    prefs.set(RAIL_KEY, v ? "1" : "0");
    set({ railCollapsed: v });
  },

  openDiff(payload: DiffPayload) {
    const id = `diff:${payload.from}:${payload.to ?? "work"}:${payload.path}`;
    const { tabs } = get();
    if (!tabs.find((t) => t.id === id)) {
      set({
        tabs: [...tabs, { id, rel: payload.path, kind: "diff", diff: payload }],
      });
    }
    set({ activeId: id });
  },
}));
