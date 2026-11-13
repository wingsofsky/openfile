/**
 * 会话转写的「显示分组」（纯函数，不改转写数据本身——归档格式是契约）。
 *
 * agent 干活时会连发几十条 tool_call / 思考，逐条平铺会把正文挤出面板。这里把**相邻的**
 * 工具调用与思考折成一个「活动组」，面板默认只显示一行摘要，点开才看明细。
 * 计划（plan）、消息、事件行不进组：它们是给人读的。
 */
import type { ToolItem, TranscriptItem } from "./acp";

export type ActivityItem = ToolItem | { kind: "thought"; text: string };

type TranscriptBlock =
  | { kind: "item"; item: Exclude<TranscriptItem, ActivityItem>; index: number }
  | { kind: "activity"; items: Array<{ item: ActivityItem; index: number }> };

export function groupTranscript(items: TranscriptItem[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  items.forEach((item, index) => {
    if (item.kind === "tool" || item.kind === "thought") {
      const last = out[out.length - 1];
      if (last?.kind === "activity") last.items.push({ item, index });
      else out.push({ kind: "activity", items: [{ item, index }] });
    } else {
      out.push({ kind: "item", item, index });
    }
  });
  return out;
}

interface ActivitySummary {
  tools: number;
  thoughts: number;
  failed: number;
  /** 还没跑完的工具（pending / in_progress）里最新的一条；都跑完了为 null */
  running: ToolItem | null;
  /** 涉及的文件（去重，保持出现顺序） */
  paths: string[];
}

export function summarizeActivity(items: Array<{ item: ActivityItem }>): ActivitySummary {
  const s: ActivitySummary = { tools: 0, thoughts: 0, failed: 0, running: null, paths: [] };
  const seen = new Set<string>();
  for (const { item } of items) {
    if (item.kind === "thought") {
      s.thoughts++;
      continue;
    }
    s.tools++;
    if (item.status === "failed") s.failed++;
    if (item.status === "pending" || item.status === "in_progress") s.running = item;
    for (const loc of item.locations) {
      if (!seen.has(loc.path)) {
        seen.add(loc.path);
        s.paths.push(loc.path);
      }
    }
  }
  return s;
}

/** sendPrompt 把「文档引用」作为第二条用户消息记进转写（document-context.ts）；显示时折成一行 */
const REFERENCE_PREFIX = "文档引用（";
export function referencePath(text: string): string | null {
  if (!text.startsWith(REFERENCE_PREFIX)) return null;
  const m = /^文库内路径：(".*")$/m.exec(text);
  if (!m) return null;
  try {
    const p: unknown = JSON.parse(m[1]);
    return typeof p === "string" ? p : null;
  } catch {
    return null;
  }
}
