/**
 * 文件树的管理态：右键菜单 / 内部剪贴板 / 重命名中 / 属性面板 / 提示。
 * 只存 UI 态；触盘全部经 src/lib/file-actions.ts → backend（两侧出证见 fileops.rs / file-ops.mjs）。
 */
import { create } from "zustand";
import type { Entry } from "../lib/types";
import { useApp } from "./store";

interface TreeMenu {
  x: number;
  y: number;
  /** null = 文库根的空白处 */
  entry: Entry | null;
}

interface FilesState {
  menu: TreeMenu | null;
  /** 内部剪贴板（不是系统剪贴板：不能粘到访达里） */
  clipboard: { rels: string[]; mode: "copy" | "cut" } | null;
  /** 多选：选中的 rel；anchor 是 Shift 连选的起点 */
  selected: string[];
  anchor: string | null;
  renaming: string | null;
  infoRel: string | null;
  /** 要求某个目录行展开（新建 / 粘贴 / 拖入之后能看见结果） */
  expand: { rel: string; ts: number } | null;
  /** 拖放悬停中的目标目录（"" = 根） */
  dropTarget: string | null;
  notice: { text: string; tone: "info" | "error"; ts: number } | null;

  openMenu(menu: TreeMenu): void;
  closeMenu(): void;
  say(text: string, tone?: "info" | "error"): void;
}

export const useFiles = create<FilesState>((set) => ({
  menu: null,
  clipboard: null,
  selected: [],
  anchor: null,
  renaming: null,
  infoRel: null,
  expand: null,
  dropTarget: null,
  notice: null,

  openMenu: (menu) => set({ menu }),
  closeMenu: () => set({ menu: null }),
  say: (text, tone = "info") => set({ notice: { text, tone, ts: Date.now() } }),
}));

// 切库：上一库的剪贴板 / 菜单 / 重命名态一律作废（rel 在新库里没有意义）
let lastRoot: string | undefined;
useApp.subscribe((s) => {
  if (s.lib?.root === lastRoot) return;
  lastRoot = s.lib?.root;
  useFiles.setState({ menu: null, clipboard: null, selected: [], anchor: null, renaming: null, infoRel: null, expand: null, dropTarget: null, notice: null });
});
