/**
 * ACP 会话内核（纯逻辑，无 IO / 无 React）：
 *   - absToRel：agent 递来的绝对路径 → 库内相对路径（词法归一）。
 *     这只是快速失败层——权威判定永远在 scoped 后端（Rust scope.rs /
 *     scoped.mjs 的 realpath 复验），符号链接逃逸在那里拦。
 *   - applyUpdate：session/update 流 → 可渲染的转写模型（不可变折叠）。
 *   - contentText / sliceLines：ContentBlock 与 fs 读取的辅助。
 *
 * 协议本体（JSON-RPC 帧、能力协商）由官方 @agentclientprotocol/sdk 承担，
 * 接线在 src/lib/agent-controller.ts；本模块保持可独立单测。
 */
import type {
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

/* ------------------------------------------------------------------ */
/* 路径映射                                                             */
/* ------------------------------------------------------------------ */

/**
 * Windows 扩展长度前缀 → 普通形式：`\\?\D:\x` → `D:\x`，`\\?\UNC\srv\share\x` → `\\srv\share\x`。
 * 其它字符串原样返回（POSIX 路径不受影响）。会话 cwd、资源 URL 都要普通形式：`\\?\` 下 `/` 不是分隔符。
 */
export function plainPath(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

/** Windows 绝对路径：盘符绝对（`D:\`、`D:/`）或 UNC（`\\srv\share`）；扩展前缀先剥 */
export function isWindowsAbsPath(p: string): boolean {
  const s = plainPath(p);
  return /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}[^\\/?.]/.test(s);
}

/**
 * Windows 绝对路径 → {卷前缀, 规范成分}；`..` 爬出卷根、NUL、成分里的 `:`（备用数据流）一律 null。
 * 卷前缀统一小写比较用；成分保留原大小写。
 */
function winParts(p: string): { volume: string; segs: string[] } | null {
  const s = plainPath(p);
  let volume: string;
  let rest: string;
  const drive = /^([A-Za-z]):[\\/]/.exec(s);
  if (drive) {
    volume = `${drive[1].toLowerCase()}:`;
    rest = s.slice(drive[0].length);
  } else {
    const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/.exec(s);
    if (!unc || unc[1] === "?" || unc[1] === ".") return null;
    volume = `\\\\${unc[1]}\\${unc[2]}`.toLowerCase();
    rest = s.slice(unc[0].length);
  }
  const segs: string[] = [];
  for (const seg of rest.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length === 0) return null;
      segs.pop();
      continue;
    }
    if (seg.includes("\0") || seg.includes(":")) return null;
    segs.push(seg);
  }
  return { volume, segs };
}

/**
 * 绝对路径 → 库内相对路径（`/` 分隔）；根之外返回 null。
 * 词法归一（`.`/`..`/重复分隔符），不触盘。根是 POSIX 路径时走 POSIX 语义（与 mac/Linux 行为逐字一致）；
 * 根是 Windows 路径时接受盘符 / UNC 绝对路径、`\` 与 `/` 混用、剥 `\\?\`，按 NTFS 不区分大小写比较根前缀。
 */
export function absToRel(root: string, abs: string): string | null {
  if (isWindowsAbsPath(root)) {
    if (!isWindowsAbsPath(abs)) return null;
    const r = winParts(root);
    const a = winParts(abs);
    if (!r || !a || r.volume !== a.volume) return null;
    if (a.segs.length <= r.segs.length) return null; // 根本身或根之上
    for (let i = 0; i < r.segs.length; i++) {
      if (r.segs[i].toLowerCase() !== a.segs[i].toLowerCase()) return null;
    }
    return a.segs.slice(r.segs.length).join("/");
  }
  if (!abs.startsWith("/")) return null;
  const segs: string[] = [];
  for (const s of abs.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (segs.length === 0) return null;
      segs.pop();
      continue;
    }
    if (s.includes("\0")) return null;
    segs.push(s);
  }
  const norm = "/" + segs.join("/");
  let rootNorm = root;
  while (rootNorm.length > 1 && rootNorm.endsWith("/")) rootNorm = rootNorm.slice(0, -1);
  if (norm === rootNorm) return null; // 根本身不是文件
  if (!norm.startsWith(rootNorm + "/")) return null;
  return norm.slice(rootNorm.length + 1);
}

/** fs/read_text_file 的 line/limit 语义（1 起始行号；limit = 行数） */
export function sliceLines(
  content: string,
  line?: number | null,
  limit?: number | null,
): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit != null ? start + Math.max(0, limit) : lines.length;
  const out = lines.slice(start, end).join("\n");
  // CRLF 文件从中间截断时，最后一行会留下半个换行（孤立的 \r）
  return end < lines.length ? out.replace(/\r$/, "") : out;
}

/* ------------------------------------------------------------------ */
/* 转写模型                                                             */
/* ------------------------------------------------------------------ */

export interface ToolItem {
  kind: "tool";
  toolCallId: string;
  title: string;
  toolKind?: ToolKind;
  status: ToolCallStatus;
  locations: ToolCallLocation[];
}

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thought"; text: string }
  | ToolItem
  | { kind: "plan"; entries: PlanEntry[] }
  /** 会话事件行（启动/退出/取消……），控制器自行插入 */
  | { kind: "info"; text: string };

/** ContentBlock → 展示文本（非文本块以占位符入转写） */
export function contentText(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "image":
      return "〔图片〕";
    case "audio":
      return "〔音频〕";
    case "resource_link":
      return `〔资源：${b.name || b.uri}〕`;
    case "resource": {
      const uri = "uri" in b.resource ? b.resource.uri : "";
      return `〔资源：${uri}〕`;
    }
    default:
      return "";
  }
}

const appendText = (
  items: TranscriptItem[],
  kind: "user" | "assistant" | "thought",
  text: string,
): TranscriptItem[] => {
  if (text === "") return items;
  const last = items[items.length - 1];
  if (last && last.kind === kind) {
    return [...items.slice(0, -1), { kind, text: last.text + text }];
  }
  return [...items, { kind, text }];
};

const lastIndexWhere = (
  items: TranscriptItem[],
  pred: (i: TranscriptItem) => boolean,
): number => {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i])) return i;
  return -1;
};

/**
 * 把一条 session/update 折进转写。返回新数组；**与入参同引用 = 非转写类
 * 更新**（modes/commands/usage 等），由控制器另行处理。
 * 连续同类文本块合并；tool_call_update 就地合并（找不到时按新工具补入，
 * 规范允许 update 先于 call 到达的乱序容错）。
 */
export function applyUpdate(
  items: TranscriptItem[],
  u: SessionUpdate,
): TranscriptItem[] {
  switch (u.sessionUpdate) {
    case "user_message_chunk":
      return appendText(items, "user", contentText(u.content));
    case "agent_message_chunk":
      return appendText(items, "assistant", contentText(u.content));
    case "agent_thought_chunk":
      return appendText(items, "thought", contentText(u.content));
    case "tool_call": {
      const item: ToolItem = {
        kind: "tool",
        toolCallId: u.toolCallId,
        title: u.title,
        toolKind: u.kind,
        status: u.status ?? "pending",
        locations: u.locations ?? [],
      };
      return [...items, item];
    }
    case "tool_call_update": {
      const i = lastIndexWhere(
        items,
        (t) => t.kind === "tool" && t.toolCallId === u.toolCallId,
      );
      if (i === -1) {
        return [
          ...items,
          {
            kind: "tool",
            toolCallId: u.toolCallId,
            title: u.title ?? "（工具）",
            toolKind: u.kind ?? undefined,
            status: u.status ?? "pending",
            locations: u.locations ?? [],
          },
        ];
      }
      const prev = items[i] as ToolItem;
      const next: ToolItem = {
        ...prev,
        title: u.title ?? prev.title,
        toolKind: u.kind ?? prev.toolKind,
        status: u.status ?? prev.status,
        locations: u.locations ?? prev.locations,
      };
      return [...items.slice(0, i), next, ...items.slice(i + 1)];
    }
    case "plan":
      return replacePlan(items, u.entries);
    case "plan_update":
      // v1 只认 items 变体；file/markdown 计划体不进转写
      if (u.plan.type === "items") return replacePlan(items, u.plan.entries);
      return items;
    case "plan_removed": {
      const i = lastIndexWhere(items, (t) => t.kind === "plan");
      if (i === -1) return items;
      return [...items.slice(0, i), ...items.slice(i + 1)];
    }
    default:
      // 非转写类更新：控制器处理（modes/commands/config/usage/压缩……）
      return items;
  }
}

function replacePlan(items: TranscriptItem[], entries: PlanEntry[]): TranscriptItem[] {
  const i = lastIndexWhere(items, (t) => t.kind === "plan");
  const item: TranscriptItem = { kind: "plan", entries };
  if (i === -1) return [...items, item];
  return [...items.slice(0, i), item, ...items.slice(i + 1)];
}
