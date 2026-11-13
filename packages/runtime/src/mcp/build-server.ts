/** MCP server 实例装配：按 --tools 分组门注册各组工具。 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { OPENFILE_VERSION, OPTS } from "./context.ts";
import type { ToolScope } from "./tool-kit.ts";
import { TOOL_ANNOTATIONS, TOOL_GROUPS, instructions } from "./tool-policy.ts";
import { registerLibraryTools } from "./tools/library.ts";
import { registerReviewTools } from "./tools/review.ts";
import { registerSnapshotsTools } from "./tools/snapshots.ts";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "openfile", version: OPENFILE_VERSION }, { instructions: instructions(OPTS.tools) });

  /** 分组门（--tools）：没开的分组不注册，工具定义不进客户端上下文 */
  const enabled = new Set<string>([...OPTS.tools].flatMap((g) => [...TOOL_GROUPS[g]]));
  const registerTool = ((name: string, cfg: unknown, cb: unknown) => {
    if (!enabled.has(name)) return undefined;
    const withAnn = TOOL_ANNOTATIONS[name] ? { annotations: TOOL_ANNOTATIONS[name], ...(cfg as Record<string, unknown>) } : cfg;
    return (server.registerTool as unknown as (n: string, c: unknown, f: unknown) => unknown)(name, withAnn, cb);
  }) as unknown as McpServer["registerTool"];

  const scope: ToolScope = { registerTool };
  registerLibraryTools(scope);
  registerReviewTools(scope);
  registerSnapshotsTools(scope);
  return server;
}
