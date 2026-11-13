#!/usr/bin/env node
/**
 * Mock ACP agent —— 零依赖的 stdio ndjson 进程，三个用途：
 *   1. e2e（scripts/e2e-acp.mjs）：不花 token、不要网络地验证传输层与协议回环
 *   2. 面板联调：agent 面板选「Mock」预设即可本地演示整套交互
 *   3. 协议线格式的活文档（JSON-RPC 2.0 + ACP v1 的最小忠实实现）
 *
 * 按提示词关键字演戏：
 *   「思考」→ agent_thought_chunk；「计划」→ plan；「工具」→ tool_call + 权限请求；
 *   「读 <rel>」→ fs/read_text_file(cwd/<rel>) 并回读内容；「写 <rel>」→ fs/write_text_file；
 *   「越界」→ 故意请求 cwd 外的绝对路径（客户端必须拒绝——e2e 攻击用例）；
 *   「列 MCP」→ 像真 agent 一样拉起 session/new 收到的 stdio MCP server，回报各自的工具数；
 *   其余 → 分两块回显。收到 session/cancel 的当轮以 cancelled 收束。
 */
import process from "node:process";
import path from "node:path";
import { spawn } from "node:child_process";

let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}
let cwd = process.cwd();
let cancelled = false;
let mcpServers = [];

/** stdio MCP：initialize → tools/list，返回工具数（失败返回错误文字）。 */
function mcpToolCount(server) {
  return new Promise((resolve) => {
    const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "pipe"], cwd, windowsHide: true });
    let buf = "";
    const timer = setTimeout(() => finish("超时"), 30_000);
    const finish = (r) => {
      clearTimeout(timer);
      child.kill();
      resolve(r);
    };
    child.on("error", (e) => finish(e.message));
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list", params: {} });
        } else if (m.id === 2) finish(m.result?.tools?.length ?? "无工具");
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock-acp-agent", version: "0" } } });
  });
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function update(sessionId, upd) {
  notify("session/update", { sessionId, update: upd });
}
const text = (t) => ({ type: "text", text: t });

async function handlePrompt({ sessionId, prompt }) {
  cancelled = false;
  const asked = prompt
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (asked.includes("列 MCP")) {
    const parts = [];
    for (const s of mcpServers) parts.push(`${s.name}=${await mcpToolCount(s)}`);
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(`MCP：${parts.join(" ") || "无"}`) });
    return { stopReason: "end_turn" };
  }

  if (asked.includes("思考")) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: text("（假装在思考……）") });
  }
  if (asked.includes("计划")) {
    update(sessionId, {
      sessionUpdate: "plan",
      entries: [
        { content: "读目标文档", priority: "high", status: "completed" },
        { content: "写回建议标记", priority: "high", status: "in_progress" },
      ],
    });
  }

  if (asked.includes("用量")) {
    // ACP usage_update：used 是**当前上下文占用**（压缩后回落），不是累计消耗；累计只有可选的 cost
    update(sessionId, { sessionUpdate: "usage_update", used: 42_000, size: 200_000, cost: { amount: 1.25, currency: "USD" } });
  }

  const readM = asked.match(/读\s+(\S+)/);
  if (readM) {
    const p = path.resolve(cwd, readM[1]);
    try {
      const { content } = await request("fs/read_text_file", { sessionId, path: p });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: text(`读到 ${readM[1]}（${content.length} 字符）：${content.slice(0, 80)}`),
      });
    } catch (e) {
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: text(`读取被拒：${e.message}`),
      });
    }
    return { stopReason: "end_turn" };
  }

  const writeM = asked.match(/写\s+(\S+)\s+(.+)/s);
  if (writeM) {
    const p = path.resolve(cwd, writeM[1]);
    try {
      await request("fs/write_text_file", { sessionId, path: p, content: writeM[2] });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(`已写入 ${writeM[1]}`) });
    } catch (e) {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(`写入被拒：${e.message}`) });
    }
    return { stopReason: "end_turn" };
  }

  if (asked.includes("越界")) {
    // 攻击用例：cwd 之外的绝对路径。合规客户端必须拒绝而不是把内容递出来。
    try {
      const r = await request("fs/read_text_file", { sessionId, path: "/etc/hosts" });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: text(`LEAKED:${r.content.slice(0, 40)}`),
      });
    } catch (e) {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(`拒绝越界：${e.message}`) });
    }
    return { stopReason: "end_turn" };
  }

  if (asked.includes("工具")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "演示工具",
      kind: "edit",
      status: "pending",
      locations: [{ path: path.resolve(cwd, "README.md") }],
    });
    const { outcome } = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "call-1", title: "演示工具" },
      options: [
        { optionId: "allow", name: "允许", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ],
    });
    const ok = outcome.outcome === "selected" && outcome.optionId === "allow";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: ok ? "completed" : "failed",
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: text(ok ? "工具已执行。" : "你拒绝了工具。"),
    });
    return { stopReason: "end_turn" };
  }

  if (asked.includes("慢")) {
    // 可取消的长回合：每 200ms 一块，直到 cancel
    for (let i = 0; i < 50; i++) {
      if (cancelled) return { stopReason: "cancelled" };
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(`第 ${i + 1} 块。`) });
      await new Promise((r) => setTimeout(r, 200));
    }
    return { stopReason: "end_turn" };
  }

  update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("你说：") });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(asked) });
  return { stopReason: "end_turn" };
}

const handlers = {
  initialize: (p) => ({
    protocolVersion: Math.min(1, p?.protocolVersion ?? 1),
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "openfile-mock-agent", version: "0.1.0" },
    authMethods: [],
  }),
  "session/new": (p) => {
    if (p?.cwd) cwd = p.cwd;
    mcpServers = Array.isArray(p?.mcpServers) ? p.mcpServers : [];
    return {
      sessionId: "mock-session-1",
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "默认", description: "逐次确认" },
          { id: "yolo", name: "放手", description: "不再确认" },
        ],
      },
    };
  },
  "session/prompt": handlePrompt,
};

let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    void dispatch(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

async function dispatch(msg) {
  // 响应：接回挂起的出向请求
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "error"));
      else p.resolve(msg.result);
    }
    return;
  }
  if (msg.method === "session/cancel") {
    cancelled = true;
    return;
  }
  const h = handlers[msg.method];
  if (msg.id === undefined) return; // 未知通知：忽略
  if (!h) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `method not found: ${msg.method}` },
    });
    return;
  }
  try {
    const result = await h(msg.params);
    send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message ?? String(e) } });
  }
}
