/**
 * Openfile MCP server（stdio）。
 *
 * 独立于桌面 app 的进程：任何支持 MCP 的 agent（Claude Code / Codex / Gemini CLI…）经它读写文库、以 CriticMarkup
 * 建议标记参与审阅、读影子仓库的快照与 diff；桌面版和浏览器模式的侧栏对话也给会话注入这一份。
 * 安全同源：一切触盘走 packages/runtime/src/lib/scoped.mjs（与 dev 桥共享、与 Rust scope.rs 对齐）。
 *
 * 启动（`openfile mcp`；旧入口 scripts/openfile-mcp.mjs 转发到这里，开发态直跑 TS 源码）：
 *   openfile mcp --root /path/to/library [--tools library,review,snapshots]
 *
 * 纪律：stdout 属于 JSON-RPC，一切日志走 stderr。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ROOT } from "./context.ts";
import { buildServer } from "./build-server.ts";

const server = buildServer();
await server.connect(new StdioServerTransport());
console.error(`[openfile-mcp] 就绪：${ROOT}`);
