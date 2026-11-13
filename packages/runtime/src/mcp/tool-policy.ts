/** MCP server：工具分组、说明、工具注解。 */

/**
 * 工具分组（`--tools`）：按需登记，常驻上下文只装用得上的工具定义。不传时全开。说明见 docs/guide/mcp-tools.md。
 */
export const TOOL_GROUPS = {
  library: ["library_info", "list_dir", "read_doc", "search_files", "search_text", "write_doc"],
  review: ["read_annotations", "suggest_edit", "add_comment"],
  snapshots: ["list_snapshots", "snapshot_now", "snapshot_changes", "diff_since"],
} as const;
export type ToolGroup = keyof typeof TOOL_GROUPS;
export const ALL_TOOL_GROUPS = Object.keys(TOOL_GROUPS) as ToolGroup[];

/** server 说明按启用的分组裁剪：没开的分组不写它的规则，只在末尾提一句还有哪些组可加 */
export function instructions(groups: ReadonlySet<ToolGroup> = new Set(ALL_TOOL_GROUPS)): string {
  const lines: Array<[ToolGroup | null, string]> = [
    [null, "Openfile 文库桥。约定："],
    [null, "- 所有路径都是文库内相对路径；"],
    ["review", "- 修改他人文档一律用 suggest_edit / add_comment（CriticMarkup 建议标记，人在 Openfile 里逐条接受/拒绝），不要直接改写原文；自己新建的产出文档才用 write_doc；"],
    ["review", "- 文档中【…】是给 agent 的话，读到要遵循；"],
    ["snapshots", "- 大改动前可以 snapshot_now 打快照；diff_since 看某个快照以来文库改了什么。"],
  ];
  const out = lines.filter(([g]) => g === null || groups.has(g)).map(([, l]) => l);
  const off = ALL_TOOL_GROUPS.filter((g) => !groups.has(g));
  if (off.length) out.push(`- 本次只开了这些工具分组：${[...groups].join(", ")}；${off.join(", ")} 没开，需要时请用户在 MCP 登记里加 --tools。`);
  return out.join("\n");
}

/**
 * 工具注解（MCP 规范 ToolAnnotations）：客户端据此决定审批——Codex 对没标 readOnlyHint 的 MCP 工具一律要审批，
 * 无头（approval_policy=never）时直接失败。读类工具标只读；建议/批注是追加、非破坏；写文档等标破坏性。
 * 全部 openWorldHint=false（只碰本地文库）。
 */
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const APPEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const TOOL_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  library_info: RO,
  list_dir: RO,
  read_doc: RO,
  search_files: RO,
  search_text: RO,
  read_annotations: RO,
  list_snapshots: RO,
  diff_since: RO,
  suggest_edit: APPEND,
  add_comment: APPEND,
  snapshot_now: APPEND,
  write_doc: WRITE,
  snapshot_changes: WRITE,
};

/** 全文搜索只看这些扩展名（其余按二进制/不相干跳过） */
export const SEARCHABLE_EXT = new Set([".md", ".markdown", ".txt", ".json", ".jsonl", ".csv", ".log", ".yaml", ".yml", ".toml", ".html", ".htm", ".tex", ".rst"]);
