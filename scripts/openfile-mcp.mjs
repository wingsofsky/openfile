#!/usr/bin/env node
/** 从源码检出登记 MCP 用的入口（claude mcp add / ~/.codex/config.toml，文档推荐写法）：转发到 `openfile mcp`（packages/runtime）。 */
if (!process.features?.typescript) {
  console.error(`Openfile 需要 Node ≥22.19（能直接运行 TypeScript）；当前 ${process.version}`);
  process.exit(1);
}
process.argv.splice(2, 0, "mcp");
await import("../packages/runtime/src/cli.ts");
