#!/usr/bin/env node
/** 从源码检出用的会话导入入口（skill 与文档里的写法）：转发到 `openfile import-sessions`（packages/runtime/src/sessions/session-import.mjs）。 */
await import("../packages/runtime/src/sessions/session-import.mjs");
