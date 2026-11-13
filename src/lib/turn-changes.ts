/**
 * 会话一轮改了什么。纯逻辑，有单测；快照与写盘的 IO 在 agent-controller 与 ChangeReview。
 *
 * 契约：
 * - 每轮发消息前强制拍影子快照「会话第 N 轮前」（不看自动快照开关），轮结束再拍「会话第 N 轮后」。
 *   没有变化时快照返回 null，用当时最新的快照代替。本轮改动 = 轮前 → 轮后（中间的自动快照也算）。
 * - 改动只靠快照得出，不靠 agent 配合：哪家 CLI 自己写盘都标得出。
 * - 撤回只在本轮结束后可点。逐块撤回写盘带完整基线；整轮撤回先拍一张快照，轮后又被改过的文件跳过并列出。
 * - 块的切法与 @codemirror/merge 的 unifiedMergeView 同一份（Chunk.build），横幅上的「N 处」与审阅视图一致。
 */
import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import type { FileChange } from "./types";

type TurnPhase = "前" | "后";

/** 快照标签（数据串，不翻译） */
export const turnLabel = (turn: number, phase: TurnPhase) => `会话第 ${turn} 轮${phase}`;

export interface TurnChanges {
  /** 拍快照时的文库根：切库后旧轮的改动不再显示、不能撤回 */
  root: string;
  turn: number;
  baseId: string;
  headId: string;
  /** 轮前 → 轮后改过的文件（库内相对路径，`/` 分隔） */
  files: FileChange[];
}

/**
 * Openfile 自己的会话记录（内嵌正文归档、导入档案）：轮中由 Openfile 写，
 * 不算 agent 对文档的改动，也绝不跟着整轮撤回。
 */
const RECORD_DIRS = ["会话/内嵌/", "会话/导入/"];

/** 快照比出的改动里去掉会话记录，剩下的才是本轮对文档的改动 */
export function documentChanges(files: readonly FileChange[]): FileChange[] {
  return files.filter((f) => !RECORD_DIRS.some((d) => f.path.startsWith(d)));
}

/** 与 unifiedMergeView 相同的 diff 上限（库默认 scanLimit 500） */
const DIFF_CONFIG = { scanLimit: 500 } as const;

/** 文本 → CM 文档：`\r\n`、`\r`、`\n` 都当换行（与编辑器一致） */
const toDoc = (s: string) => Text.of(s.split(/\r\n?|\n/));

/** 基线 → 当前的改动块（行为单位，与审阅视图同一切法） */
export function chunksBetween(base: string, current: string): readonly Chunk[] {
  return Chunk.build(toDoc(base), toDoc(current), DIFF_CONFIG);
}

/**
 * 当前文档里本轮改过的行（1 起）：阅读视图据此高亮段落。纯删除的块落在其后一行
 * （删掉的东西在阅读视图里看不见，标出它原来所在的位置）。
 */
export function changedLines(base: string, current: string): Set<number> {
  const b = toDoc(current);
  const out = new Set<number>();
  for (const c of chunksBetween(base, current)) {
    const from = Math.min(c.fromB, b.length);
    const to = Math.max(from, Math.min(c.toB, b.length) - 1);
    const first = b.lineAt(from).number;
    const last = b.lineAt(to).number;
    for (let n = first; n <= last; n++) out.add(n);
  }
  return out;
}

/** 本轮是否改过这份文档 */
export function touchedInTurn(tc: TurnChanges | null, root: string | undefined, rel: string): FileChange | null {
  if (!tc || tc.root !== root) return null;
  return tc.files.find((f) => f.path === rel) ?? null;
}

interface UndoPlan {
  /** 恢复成轮前内容（本轮改过或删掉的） */
  restore: string[];
  /** 移进废纸篓（本轮新建的） */
  trash: string[];
  /** 不动：轮后又被改过，或改动类型认不出 */
  skipped: string[];
}

/**
 * 整轮撤回的计划。touchedAfterTurn = 轮后快照之后又变过的路径（撤回前现拍一张快照比出来）：
 * 那些文件已经不是本轮结束时的样子，撤回会盖掉别人的改动，跳过并列出。
 */
export function planTurnUndo(files: readonly FileChange[], touchedAfterTurn: Iterable<string>): UndoPlan {
  const after = new Set(touchedAfterTurn);
  const plan: UndoPlan = { restore: [], trash: [], skipped: [] };
  for (const f of files) {
    if (after.has(f.path)) plan.skipped.push(f.path);
    else if (f.status === "added") plan.trash.push(f.path);
    else if (f.status === "modified" || f.status === "deleted") plan.restore.push(f.path);
    else plan.skipped.push(f.path);
  }
  return plan;
}
