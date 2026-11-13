#!/usr/bin/env node
/**
 * 黑盒 E2E：ACP 会话传输层（运行时 api/processes.ts，经 dev-runtime 的 /__rpc 与 /__rpc/events）。
 * 起真实 vite dev + 真实 mock agent 子进程，在 HTTP/SSE 层扮演客户端跑完
 * 整个 ACP 握手与双向请求回环。覆盖：
 *   - 护栏：未选库 409、缺显式请求头 403（CSRF 挡板）、进程编号只认安全字符
 *   - 先订阅事件流、再用自己生成的进程编号 spawn → 字节流 → ndjson 帧组装（跨 b64 块边界）
 *   - initialize / session/new / session/prompt / session/update 流
 *   - agent→client 反向请求（fs/read_text_file）双向路由
 *   - 秒退进程：订阅在 spawn 之前，退出码与 stderr 一个不丢
 *   - kill 幂等 + 退出后 stdin 404
 * 协议客户端的路径纪律（absToRel 拒库外）在 src/lib/agent-controller.test.ts。
 * 退出码非零 = 失败。用法：node scripts/e2e-acp.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 1478;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = path.resolve(import.meta.dirname, "..");
const MOCK = path.join(REPO, "scripts", "mock-acp-agent.mjs");
let failures = 0;
let vite = null;

function ok(cond, name, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const RPC_HEADERS = { "content-type": "application/json", "x-openfile-request": "1" };
/** 与桥的 canonicalRoot 同口径：Windows 用原生 realpath（展开 8.3 短名——CI 的 TEMP 是 C:\Users\RUNNER~1\…） */
const canonical = (p) => (process.platform === "win32" ? fs.realpathSync.native(p) : fs.realpathSync(p));

/** 调运行时方法：成功 body = result，失败 body = {error} */
async function rpc(method, params = {}, headers = RPC_HEADERS) {
  const r = await fetch(`${BASE}/__rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }) });
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, body: r.status === 200 ? body?.result ?? null : body };
}

async function waitReady(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/__rpc`, { method: "POST", headers: RPC_HEADERS, body: JSON.stringify({ method: "library.get" }) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("vite dev 未在超时内就绪");
}

/** 一条事件流（/__rpc/events）按进程编号分给各个 AgentTap；连上之后才 spawn，帧不会早于订阅 */
const taps = new Map();
let streamAbort = null;
async function connectEvents() {
  const ac = new AbortController();
  streamAbort = ac;
  const res = await fetch(`${BASE}/__rpc/events`, { signal: ac.signal });
  if (!res.ok) throw new Error(`SSE ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let connected;
  const ready = new Promise((r) => (connected = r));
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes(": connected")) connected();
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const e = JSON.parse(line.slice(6));
          if (e.type === "proc") taps.get(e.pid)?.onFrame(e);
        }
      }
    }
  })();
  await ready;
}

let pidSeq = 0;
/** 登记接收端 → 调 spawn 方法（cmd/args）；返回 {status, body, pid, tap} */
async function spawnWith(method, params, headers = RPC_HEADERS) {
  const pid = params.pid ?? `e2e-${process.pid}-${++pidSeq}`;
  const tap = new AgentTap();
  taps.set(pid, tap);
  const r = await rpc(method, { ...params, pid }, headers);
  if (r.status !== 200) taps.delete(pid);
  return { ...r, pid, tap };
}

/** 帧 → {stdout→ndjson 消息队列, stderr, exit} */
class AgentTap {
  constructor() {
    this.msgs = [];
    this.stderr = [];
    this.exit = undefined; // {code}
    this.ndBuf = "";
  }
  onFrame(f) {
    if (f.stream === "stdout") {
      this.ndBuf += Buffer.from(f.b64, "base64").toString("utf-8");
      let i;
      while ((i = this.ndBuf.indexOf("\n")) !== -1) {
        const line = this.ndBuf.slice(0, i);
        this.ndBuf = this.ndBuf.slice(i + 1);
        if (line.trim()) this.msgs.push(JSON.parse(line));
      }
    } else if (f.stream === "stderr") this.stderr.push(f.line);
    else if (f.stream === "exit") this.exit = { code: f.code };
  }
  /** 等待并取走首条满足条件的消息 */
  async take(pred, ms = 8000, what = "消息") {
    const t0 = Date.now();
    for (;;) {
      const i = this.msgs.findIndex(pred);
      if (i !== -1) return this.msgs.splice(i, 1)[0];
      if (Date.now() - t0 > ms) throw new Error(`等待${what}超时；已见: ${JSON.stringify(this.msgs).slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async waitExit(ms = 8000) {
    const t0 = Date.now();
    while (this.exit === undefined) {
      if (Date.now() - t0 > ms) throw new Error("等待退出超时");
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.exit;
  }
}

let rpcId = 0;
const send = (pid, obj) => rpc("proc.write", { pid, data: JSON.stringify(obj) + "\n" });
const call = async (id, tap, method, params) => {
  const myId = ++rpcId;
  await send(id, { jsonrpc: "2.0", id: myId, method, params });
  const r = await tap.take((m) => m.id === myId && m.method === undefined, 8000, method);
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};

async function main() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-acp-"));
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-acp-data-"));
  fs.writeFileSync(path.join(lib, "hello.md"), "# 你好\n这是测试文档。\n");
  console.log(`fixture 文库: ${lib}`);

  // spawn node + vite.js directly: "pnpm" is a .cmd/.ps1 shim on Windows, un-spawnable without a shell
  const viteBin = path.join(REPO, "node_modules", "vite", "bin", "vite.js");
  vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: REPO,
    env: { ...process.env, OPENFILE_LIBRARY: "", OPENFILE_APPDATA: appdata },
    stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stderr.on("data", (d) => process.env.E2E_VERBOSE && console.error(String(d)));
  await waitReady();
  await connectEvents();

  console.log("\n[1] 护栏");
  const noLib = await spawnWith("proc.spawnAgent", { cmd: "node", args: [MOCK] });
  ok(noLib.status === 409, "未选库时 spawn 拒绝", `got ${noLib.status}`);

  await rpc("library.open", { path: lib });

  const noHdr = await spawnWith("proc.spawnAgent", { cmd: "node", args: [MOCK] }, { "content-type": "application/json" });
  ok(noHdr.status === 403, "缺 x-openfile-request 头拒绝（CSRF 挡板）", `got ${noHdr.status}`);
  ok((await rpc("proc.write", { pid: "x", data: "{}" }, { "content-type": "application/json" })).status === 403, "stdin 同样受头护栏");
  ok((await rpc("proc.spawnAgent", { pid: "../x", cmd: "node", args: [] })).status === 400, "进程编号只认安全字符");

  console.log("\n[2] 握手与会话（真 mock agent 进程）");
  const sp = await spawnWith("proc.spawnAgent", { cmd: "node", args: [MOCK] });
  ok(sp.status === 200, "spawn 成功", JSON.stringify(sp.body));
  const id = sp.pid;
  const tap = sp.tap;

  const init = await call(id, tap, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
  ok(init.protocolVersion === 1, "initialize 协商 v1");
  ok(init.agentInfo?.name === "openfile-mock-agent", "agentInfo 名称");

  // 会话注入的 Openfile MCP（3a-1）：桥给出拉起方式，原样交给 session/new
  const mcpNoHdr = await rpc("agent.mcpServer", { expectedRoot: canonical(lib) }, { "content-type": "application/json" });
  ok(mcpNoHdr.status === 403, "mcp-server 缺显式请求头 403", `status=${mcpNoHdr.status}`);
  const wrongRoot = await rpc("agent.mcpServer", { expectedRoot: path.join(os.tmpdir(), "别的库") });
  ok(wrongRoot.status === 409, "mcp-server 文库已切换 409", `status=${wrongRoot.status}`);
  const mcp = await rpc("agent.mcpServer", { expectedRoot: canonical(lib) });
  ok(mcp.status === 200 && mcp.body?.args?.slice(-5).join(" ") === `mcp --root ${canonical(lib)} --tools all`, "mcp-server 给出 mcp --root <文库> --tools all（内嵌会话要读文件、审阅、快照工具）", JSON.stringify(mcp.body));

  const ns = await call(id, tap, "session/new", { cwd: lib, mcpServers: [{ name: "openfile", command: mcp.body.command, args: mcp.body.args, env: [] }] });
  ok(typeof ns.sessionId === "string", "session/new 返回 sessionId");
  ok(ns.modes?.currentModeId === "default", "初始模式");

  const pM = ++rpcId;
  await send(id, { jsonrpc: "2.0", id: pM, method: "session/prompt", params: { sessionId: ns.sessionId, prompt: [{ type: "text", text: "列 MCP" }] } });
  const mcpSeen = await tap.take((m) => m.method === "session/update" && m.params?.update?.content?.text?.startsWith("MCP："), 40000, "MCP 工具数");
  const count = Number(/openfile=(\d+)/.exec(mcpSeen.params.update.content.text)?.[1]);
  ok(count === 13, "agent 按注入的配置拉起 Openfile MCP 并列出读文件、审阅、快照 13 个工具", mcpSeen.params.update.content.text);
  await tap.take((m) => m.id === pM, 8000, "列 MCP 轮响应");

  console.log("\n[3] 提示轮 + update 流");
  const p1 = ++rpcId;
  await send(id, { jsonrpc: "2.0", id: p1, method: "session/prompt", params: { sessionId: ns.sessionId, prompt: [{ type: "text", text: "回显 甲乙丙" }] } });
  const upd = await tap.take((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk" && m.params.update.content.text.includes("甲乙丙"), 8000, "回显块");
  ok(upd.params.sessionId === ns.sessionId, "update 归属正确会话");
  const done1 = await tap.take((m) => m.id === p1, 8000, "prompt 响应");
  ok(done1.result?.stopReason === "end_turn", "轮末 end_turn");

  const pU = ++rpcId;
  await send(id, { jsonrpc: "2.0", id: pU, method: "session/prompt", params: { sessionId: ns.sessionId, prompt: [{ type: "text", text: "用量" }] } });
  const usage = await tap.take((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "usage_update", 8000, "usage_update");
  ok(usage.params.update.used === 42000 && usage.params.update.size === 200000, "usage_update 带上下文占用（used 是占用、不是累计消耗）", JSON.stringify(usage.params.update));
  ok(usage.params.update.cost?.currency === "USD", "usage_update 带可选的累计花费");
  await tap.take((m) => m.id === pU, 8000, "用量轮响应");

  console.log("\n[4] 反向请求：agent → client fs 代理（双向路由）");
  const p2 = ++rpcId;
  await send(id, { jsonrpc: "2.0", id: p2, method: "session/prompt", params: { sessionId: ns.sessionId, prompt: [{ type: "text", text: "读 hello.md" }] } });
  const fsReq = await tap.take((m) => m.method === "fs/read_text_file", 8000, "fs 读请求");
  ok(fsReq.params.path === path.join(lib, "hello.md"), "请求带绝对路径", fsReq.params.path);
  // 扮演合规客户端应答（真客户端的 scoped 纪律在 controller 单测里钉死）
  await send(id, { jsonrpc: "2.0", id: fsReq.id, result: { content: "# 你好（代理内容）" } });
  const echo = await tap.take((m) => m.method === "session/update" && m.params?.update?.content?.text?.includes("代理内容"), 8000, "读回显");
  ok(!!echo, "内容经代理回到 agent 消息");
  ok((await tap.take((m) => m.id === p2)).result.stopReason === "end_turn", "fs 轮收束");

  console.log("\n[5] 越界请求走到客户端为止（拒绝语义在客户端）");
  const p3 = ++rpcId;
  await send(id, { jsonrpc: "2.0", id: p3, method: "session/prompt", params: { sessionId: ns.sessionId, prompt: [{ type: "text", text: "越界" }] } });
  const evil = await tap.take((m) => m.method === "fs/read_text_file", 8000, "越界读请求");
  ok(evil.params.path === "/etc/hosts", "库外绝对路径原样抵达客户端裁决点");
  await send(id, { jsonrpc: "2.0", id: evil.id, error: { code: -32602, message: "路径在文库之外，Openfile 拒绝代理" } });
  const refuse = await tap.take((m) => m.method === "session/update" && m.params?.update?.content?.text?.includes("拒绝越界"), 8000, "拒绝回显");
  ok(!!refuse && !JSON.stringify(tap.msgs).includes("LEAKED"), "agent 收到拒绝而非内容");
  await tap.take((m) => m.id === p3);

  console.log("\n[6] kill 与收尸");
  await rpc("proc.kill", { pid: id });
  const ex = await tap.waitExit();
  ok(ex.code === 0 || ex.code === null, "退出帧到达", `code=${ex.code}`);
  const dead = await rpc("proc.write", { pid: id, data: "x" });
  ok(dead.status === 404, "退出后 stdin 404");
  ok((await rpc("proc.kill", { pid: id })).status === 200, "kill 幂等");

  console.log("\n[7] 秒退进程（订阅在 spawn 之前，帧一个不丢）");
  const sp2 = await spawnWith("proc.spawnAgent", { cmd: "node", args: ["-e", "console.error('炸了'); process.exit(3)"] });
  const ex2 = await sp2.tap.waitExit();
  ok(ex2.code === 3, "秒退进程的退出码到达", `code=${ex2.code}`);
  ok(sp2.tap.stderr.some((l) => l.includes("炸了")), "秒退进程的 stderr 到达");
  const reuse = await spawnWith("proc.spawnAgent", { cmd: "node", args: ["-e", "1"], pid: sp2.pid });
  ok(reuse.status === 200, "退出后编号可回收");
  await reuse.tap.waitExit();

  console.log("\n[8] spawn 失败路径（命令不存在）");
  const sp3 = await spawnWith("proc.spawnAgent", { cmd: "/绝不存在/的命令", args: [] });
  ok(sp3.status === 200, "spawn 调用本身成功（错误经事件流报告）");
  const tap3 = sp3.tap;
  const ex3 = await tap3.waitExit();
  ok(ex3.code === null && tap3.stderr.some((l) => l.includes("spawn 失败")), "spawn 失败经 stderr+exit 帧报告");

  console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 个断言失败 ✗`);
}

main()
  .catch((e) => {
    failures++;
    console.error(`\n致命错误: ${e.message}`);
  })
  .finally(() => {
    streamAbort?.abort();
    // Windows 上 kill() 只杀 node 本身：整棵树收掉，strictPort 1478 才会释放
    if (vite && vite.exitCode === null && vite.signalCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(vite.pid)], { stdio: "ignore", windowsHide: true });
      else vite.kill();
    }
    process.exit(failures === 0 ? 0 : 1);
  });
