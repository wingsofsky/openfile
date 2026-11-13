// @vitest-environment node
/**
 * 会话控制器契约测试：真 SDK 双端（ClientSideConnection ↔ AgentSideConnection）
 * 在内存字节流上对接——不起子进程、不触盘。假 agent 按提示词关键字演戏，
 * 假 backend 记录一切 fs 调用：核心断言是 **fs 代理的路径纪律**
 * （库外绝对路径被拒且从不触达 backend）与回环状态机。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  const appFiles = new Map<string, string>();
  const writes: Array<{ rel: string; content: string }> = [];
  const reads: string[] = [];
  const libraryChanges: string[] = [];
  const prompts: string[] = [];
  const state: {
    spawn: ((cmd: string, args: string[]) => unknown) | null;
    lastSpawn: { cmd: string; args: string[] } | null;
    writeError: boolean;
    mcp: { command: string; args: string[] } | null;
    mcpRoots: string[];
    sessionMcp: unknown[] | null;
    inLibrary: boolean;
  } = { spawn: null, lastSpawn: null, writeError: false, mcp: null, mcpRoots: [], sessionMcp: null, inLibrary: true };
  const snaps: Array<{ id: string; label: string; files: Map<string, string> }> = [];
  return { files, appFiles, writes, reads, state, libraryChanges, prompts, snaps };
});

vi.mock("./backend", () => {
  const backend = {
    kind: "dev",
    listDir: async () => [],
    setLibrary: async (root: string) => { h.libraryChanges.push(root); return { root, name: root }; },
    // 假影子快照：每张快照存一份 files 副本；无变化返回 null（与真后端同语义）
    snapshotNow: async (label: string) => {
      const last = h.snaps.at(-1);
      const same = last && last.files.size === h.files.size && [...h.files].every(([k, v]) => last.files.get(k) === v);
      if (same) return null;
      const snap = { id: `snap${h.snaps.length + 1}`, label, files: new Map(h.files) };
      h.snaps.push(snap);
      return { id: snap.id, time: 0, label, filesChanged: 0, insertions: 0, deletions: 0 };
    },
    listSnapshots: async () => h.snaps.slice(-1).reverse().map((s) => ({ id: s.id, time: 0, label: s.label, filesChanged: 0, insertions: 0, deletions: 0 })),
    snapshotChanges: async (id: string, from?: string) => {
      const b = h.snaps.find((s) => s.id === id)!.files;
      const a = h.snaps.find((s) => s.id === from)?.files ?? new Map<string, string>();
      const out: Array<{ path: string; status: string }> = [];
      for (const [k, v] of b) if (!a.has(k)) out.push({ path: k, status: "added" }); else if (a.get(k) !== v) out.push({ path: k, status: "modified" });
      for (const k of a.keys()) if (!b.has(k)) out.push({ path: k, status: "deleted" });
      return out;
    },
    restoreFile: async (id: string, rel: string) => {
      h.files.set(rel, h.snaps.find((s) => s.id === id)!.files.get(rel)!);
    },
    trashEntry: async (rel: string) => {
      h.files.delete(rel);
    },
    agentMcpServer: async (root: string) => {
      h.state.mcpRoots.push(root);
      return h.state.mcp;
    },
    spawnAgent: (cmd: string, args: string[]) => {
      h.state.lastSpawn = { cmd, args };
      if (!h.state.spawn) throw new Error("测试未装配 spawn");
      return Promise.resolve(h.state.spawn(cmd, args));
    },
    readText: async (rel: string) => {
      h.reads.push(rel);
      const content = h.files.get(rel);
      if (content === undefined) throw new Error("路径不可访问");
      return { content, size: content.length, truncated: false, encoding: "utf-8" };
    },
    // 假的应用数据目录（文件夹还不是文库时，档案写这里）
    archiveInLibrary: async () => h.state.inLibrary,
    writeArchive: async (name: string, content: string, expectedRoot: string) => {
      if (useApp.getState().lib?.root !== expectedRoot) throw new Error("文库已切换");
      h.appFiles.set(name, content);
    },
    readArchive: async (name: string) => {
      const content = h.appFiles.get(name);
      if (content === undefined) throw new Error("路径不可访问");
      return { content, size: content.length, truncated: false, encoding: "utf-8" };
    },
    writeText: async (rel: string, content: string, expectedRoot?: string) => {
      if (h.state.writeError) throw new Error("磁盘已满");
      if (expectedRoot && useApp.getState().lib?.root !== expectedRoot) throw new Error("文库已切换");
      h.writes.push({ rel, content });
      h.files.set(rel, content);
    },
  };
  return { backend } as unknown as typeof import("./backend");
});

import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type ContentBlock,
} from "@agentclientprotocol/sdk";
import type { AgentProcessHandle } from "./types";
import { useApp } from "../state/store";
import { setLocale } from "../i18n";
import { useAgent } from "../state/agent";
import {
  authenticate,
  cancelTurn,
  parseCommandLine,
  resolvePermission,
  sendPrompt,
  friendlyStartError,
  flushSessionArchive,
  setSessionMode,
  startSession,
  startSessionFromHistory,
  stopSession,
  undoTurn,
  undoTurnFile,
} from "./agent-controller";

const ROOT = "/假机器/文库";

const textOf = (blocks: ContentBlock[]) =>
  blocks.map((b) => (b.type === "text" ? b.text : "")).join("");

/** 内存版 agent 进程：SDK AgentSideConnection 直接接在回调管道上 */
function makeFakeProc(opts: { authFirst?: boolean } = {}): AgentProcessHandle {
  const stdoutCbs: Array<(b: Uint8Array) => void> = [];
  const exitCbs: Array<(c: number | null) => void> = [];
  let exited = false;
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toAgentWriter = toAgent.writable.getWriter();
  const fromAgent = new WritableStream<Uint8Array>({
    write(b) {
      stdoutCbs.forEach((cb) => cb(b));
    },
  });

  let authed = false;
  let cwd = "/";
  let cancelled = false;

  const makeAgent = (conn: AgentSideConnection): Agent => ({
    async initialize(p) {
      return {
        protocolVersion: Math.min(p.protocolVersion, PROTOCOL_VERSION),
        agentInfo: { name: "假agent", version: "0" },
        authMethods: opts.authFirst ? [{ id: "login", name: "假登录", description: null }] : [],
      };
    },
    async authenticate() {
      authed = true;
      return {};
    },
    async newSession(p) {
      if (opts.authFirst && !authed) throw RequestError.authRequired();
      cwd = p.cwd;
      h.state.sessionMcp = p.mcpServers;
      return {
        sessionId: "s1",
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "默认" },
            { id: "yolo", name: "放手" },
          ],
        },
      };
    },
    async cancel() {
      cancelled = true;
    },
    async prompt(p) {
      cancelled = false;
      const asked = textOf(p.prompt);
      h.prompts.push(asked);
      const say = (text: string) =>
        conn.sessionUpdate({
          sessionId: p.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });

      if (asked.includes("私密诊断")) {
        await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "SECRET_THOUGHT" } } });
        await say("只保存这条可见回复");
        return { stopReason: "end_turn" };
      }

      if (asked.includes("用量")) {
        await conn.sessionUpdate({
          sessionId: p.sessionId,
          update: { sessionUpdate: "usage_update", used: 42_000, size: 200_000, cost: { amount: 1.25, currency: "USD" } },
        });
        await say("用量已上报");
        return { stopReason: "end_turn" };
      }

      if (asked.includes("列命令")) {
        await conn.sessionUpdate({
          sessionId: p.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "hello-openfile", description: "演示 skill" }],
          },
        });
        await say("命令已上报");
        return { stopReason: "end_turn" };
      }
      if (asked.includes("未登录")) {
        await conn.extNotification("_auth/status_update", { authStatus: { kind: "none", label: "Not logged in" } });
        await say("状态已上报");
        return { stopReason: "end_turn" };
      }
      const readM = asked.match(/读\s+(\S+)/);
      if (readM) {
        try {
          const r = await conn.readTextFile({ sessionId: p.sessionId, path: `${cwd}/${readM[1]}` });
          await say(`读到:${r.content}`);
        } catch (e) {
          await say(`读取被拒:${(e as Error).message}`);
        }
        return { stopReason: "end_turn" };
      }
      if (asked.includes("越界")) {
        try {
          const r = await conn.readTextFile({ sessionId: p.sessionId, path: "/etc/hosts" });
          await say(`LEAKED:${r.content}`);
        } catch {
          await say("拒绝越界");
        }
        return { stopReason: "end_turn" };
      }
      const writeM = asked.match(/写\s+(\S+)\s+(\S+)/);
      if (writeM) {
        try {
          await conn.writeTextFile({
            sessionId: p.sessionId,
            path: `${cwd}/${writeM[1]}`,
            content: writeM[2],
          });
          await say("已写入");
        } catch (e) {
          await say(`写入被拒:${(e as Error).message}`);
        }
        return { stopReason: "end_turn" };
      }
      if (asked.startsWith("请用工具")) {
        await conn.sessionUpdate({
          sessionId: p.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "c1",
            title: "演示工具",
            kind: "edit",
            status: "pending",
          },
        });
        const r = await conn.requestPermission({
          sessionId: p.sessionId,
          toolCall: { toolCallId: "c1", title: "演示工具" },
          options: [
            { optionId: "allow", name: "允许", kind: "allow_once" },
            { optionId: "reject", name: "拒绝", kind: "reject_once" },
          ],
        });
        const ok = r.outcome.outcome === "selected" && r.outcome.optionId === "allow";
        await conn.sessionUpdate({
          sessionId: p.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "c1",
            status: ok ? "completed" : "failed",
          },
        });
        await say(ok ? "工具已执行" : "你拒绝了工具");
        return { stopReason: "end_turn" };
      }
      if (asked.includes("慢")) {
        for (let i = 0; i < 100; i++) {
          if (cancelled) return { stopReason: "cancelled" };
          await say(`块${i} `);
          await new Promise((r) => setTimeout(r, 10));
        }
        return { stopReason: "end_turn" };
      }
      await say("你说：");
      await say(asked);
      return { stopReason: "end_turn" };
    },
  });

  void new AgentSideConnection(makeAgent, ndJsonStream(fromAgent, toAgent.readable));

  return {
    id: 1,
    write: async (data) => {
      await toAgentWriter.write(new TextEncoder().encode(data));
    },
    kill: async () => {
      if (exited) return;
      exited = true;
      exitCbs.forEach((cb) => cb(0));
    },
    onStdout: (cb) => stdoutCbs.push(cb),
    onStderr: () => undefined,
    onExit: (cb) => exitCbs.push(cb),
  };
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const transcriptText = () =>
  useAgent
    .getState()
    .transcript.map((i) => ("text" in i ? i.text : ""))
    .join("\n");

beforeEach(async () => {
  setLocale("zh"); // 断言按中文文案写；默认语言随运行机器的 navigator.language
  h.state.writeError = false;
  await stopSession();
  h.files.clear();
  h.writes.length = 0;
  h.reads.length = 0;
  h.libraryChanges.length = 0;
  h.prompts.length = 0;
  h.state.mcp = { command: "/bin/node", args: ["/app/cli.mjs", "mcp", "--root", ROOT] };
  h.state.mcpRoots = [];
  h.state.sessionMcp = null;
  h.state.inLibrary = true;
  h.appFiles.clear();
  h.snaps.length = 0;
  useAgent.setState({ turnChanges: null, turnUndoing: false });
  h.state.spawn = () => makeFakeProc();
  useApp.setState({ lib: { root: ROOT, name: "文库" } });
  useAgent.setState({ presetId: "claude", customCmd: "", historyContext: null });
  useApp.setState({ tabs: [], activeId: null });
});

describe("会话自动带当前文件", () => {
  it("每条消息都附当前打开文件的路径，不进转写", async () => {
    await startSession();
    useApp.getState().openFile("docs/章节.md");
    sendPrompt("这一章哪里要改");
    await until(() => useAgent.getState().status === "ready");
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain('文库内路径："docs/章节.md"');
    // 假 agent 会把整条提示回显出来，所以只看用户这一侧的转写
    const userText = useAgent.getState().transcript.filter((i) => i.kind === "user").map((i) => ("text" in i ? i.text : "")).join("\n");
    expect(userText).toBe("这一章哪里要改");
    expect(useAgent.getState().contextSources).toEqual([]);
    useApp.getState().openFile("docs/下一章.md");
    sendPrompt("这一章呢");
    await until(() => useAgent.getState().status === "ready");
    expect(h.prompts[1]).toContain('文库内路径："docs/下一章.md"');
  });

  it("没打开文件时只发问题本身", async () => {
    await startSession();
    sendPrompt("你好");
    await until(() => useAgent.getState().status === "ready");
    expect(h.prompts[0]).not.toContain("文库内路径");
  });
});

afterAll(async () => {
  await stopSession();
});

describe("friendlyStartError", () => {
  it("stderr 里的 spawn ENOENT → 找不到命令的人话", () => {
    expect(friendlyStartError(new Error('{"error":"会话进程已退出"}'), ["spawn 失败: spawn gemini ENOENT"])).toContain("找不到命令「gemini」");
  });
  it("dev 桥的 JSON 错误体 → 取 error 字段；普通错误原样", () => {
    expect(friendlyStartError(new Error('{"error":"会话进程已退出"}'), [])).toBe("会话进程已退出");
    expect(friendlyStartError(new Error("适配器 120s 无响应"), [])).toBe("适配器 120s 无响应");
  });
});

describe("parseCommandLine", () => {
  it("空白分词 + 引号包裹", () => {
    expect(parseCommandLine("node a.mjs --x")).toEqual(["node", "a.mjs", "--x"]);
    expect(parseCommandLine('  node "/带 空格/agent.mjs"  ')).toEqual([
      "node",
      "/带 空格/agent.mjs",
    ]);
    expect(parseCommandLine("node '' b")).toEqual(["node", "", "b"]);
    expect(parseCommandLine("")).toEqual([]);
  });
});

describe("会话回环（真 SDK 双端内存对接）", () => {
  it("启动 → 握手 → 就绪；预设命令原样传给 spawn", async () => {
    await startSession();
    const s = useAgent.getState();
    expect(s.status).toBe("ready");
    expect(s.agentName).toBe("假agent");
    expect(s.modes?.currentModeId).toBe("default");
    expect(h.state.lastSpawn?.cmd).toBe("npx");
    expect(h.state.lastSpawn?.args).toContain("@agentclientprotocol/claude-agent-acp");
  });

  it("建会话时注入 Openfile MCP：后端给的拉起方式原样进 mcpServers", async () => {
    await startSession();
    expect(useAgent.getState().status).toBe("ready");
    expect(h.state.mcpRoots).toEqual([ROOT]);
    expect(h.state.sessionMcp).toEqual([{ name: "openfile-session", command: "/bin/node", args: ["/app/cli.mjs", "mcp", "--root", ROOT], env: [] }]);
  });

  it("找不到 Node：不注入 MCP，会话照常就绪并说明一次", async () => {
    h.state.mcp = null;
    await startSession();
    expect(useAgent.getState().status).toBe("ready");
    expect(h.state.sessionMcp).toEqual([]);
    expect(transcriptText()).toContain("本会话没有 Openfile 工具");
  });

  it("对话：chunk 流折叠为一条 assistant 消息，轮末回到就绪", async () => {
    await startSession();
    sendPrompt("你好呀");
    await until(() => useAgent.getState().status === "ready" && transcriptText().includes("你好呀"));
    const t = useAgent.getState().transcript;
    expect(t.filter((i) => i.kind === "assistant")).toHaveLength(1);
    expect(t.find((i) => i.kind === "assistant")).toMatchObject({ text: "你说：你好呀" });
  });

  it("fs 代理：库内读走 scoped 后端（相对路径），line/limit 生效", async () => {
    h.files.set("docs/a.md", "甲\n乙\n丙");
    await startSession();
    sendPrompt("读 docs/a.md");
    await until(() => transcriptText().includes("读到:"));
    expect(transcriptText()).toContain("读到:甲\n乙\n丙");
    expect(h.reads).toEqual(["docs/a.md"]);
  });

  it("fs 代理攻击：库外绝对路径被拒，且从不触达 backend", async () => {
    await startSession();
    sendPrompt("越界");
    await until(() => transcriptText().includes("拒绝越界"));
    expect(transcriptText()).not.toContain("LEAKED");
    expect(h.reads).toEqual([]); // 快速失败层拦下，backend 连相对路径都没收到
  });

  it("fs 代理：写入落到库内相对路径", async () => {
    await startSession();
    sendPrompt("写 out/新稿.md 内容甲");
    await until(() => transcriptText().includes("已写入"));
    expect(h.writes.filter((w) => !w.rel.startsWith("会话/内嵌/"))).toEqual([{ rel: "out/新稿.md", content: "内容甲" }]);
  });

  it("本轮改动：轮前 / 轮后快照比出改过的文档（不含会话档案），整轮撤回恢复改过的、移走新建的", async () => {
    h.files.set("稿/旧.md", "原文");
    await startSession();
    sendPrompt("写 稿/旧.md 改过了");
    await until(() => useAgent.getState().turnChanges !== null);
    const tc = useAgent.getState().turnChanges!;
    expect(tc.turn).toBe(1);
    expect(h.snaps.map((s) => s.label)).toEqual(["会话第 1 轮前", "会话第 1 轮后"]);
    expect(tc.files).toEqual([{ path: "稿/旧.md", status: "modified" }]);

    // 第二轮：新建一份
    sendPrompt("写 稿/新.md 新的");
    await until(() => useAgent.getState().turnChanges?.turn === 2);
    expect(useAgent.getState().turnChanges!.files).toEqual([{ path: "稿/新.md", status: "added" }]);
    await undoTurn();
    expect(h.files.has("稿/新.md")).toBe(false);
    expect(h.files.get("稿/旧.md")).toBe("改过了");
    expect(useAgent.getState().turnChanges).toBeNull();
    expect(transcriptText()).toContain("已撤回第 2 轮");
  });

  it("整轮撤回跳过轮后又被改过的文件", async () => {
    h.files.set("稿/旧.md", "原文");
    await startSession();
    sendPrompt("写 稿/旧.md 改过了");
    await until(() => useAgent.getState().turnChanges !== null);
    h.files.set("稿/旧.md", "我后来又改的");
    await undoTurn();
    expect(h.files.get("稿/旧.md")).toBe("我后来又改的");
    expect(transcriptText()).toContain("轮后又被改过、没动：稿/旧.md");
  });

  it("整份撤回单个文件：只动这一个，撤成后从本轮改动里去掉；新建的进废纸篓", async () => {
    h.files.set("稿/报告.docx", "原文");
    await startSession();
    sendPrompt("写 稿/报告.docx 改过了");
    await until(() => useAgent.getState().turnChanges !== null);
    const tc = useAgent.getState().turnChanges!;
    // 同一轮里还有别的文件：整份撤回不碰它，它留在本轮改动里
    useAgent.setState({ turnChanges: { ...tc, files: [...tc.files, { path: "稿/别的.md", status: "modified" }] } });
    expect(await undoTurnFile("稿/报告.docx")).toBe("已把 稿/报告.docx 撤回到第 1 轮之前。");
    expect(h.files.get("稿/报告.docx")).toBe("原文");
    expect(useAgent.getState().turnChanges!.files).toEqual([{ path: "稿/别的.md", status: "modified" }]);
    expect(await undoTurnFile("稿/报告.docx")).toBeNull();

    sendPrompt("写 稿/新.docx 新的");
    await until(() => useAgent.getState().turnChanges?.turn === 2);
    expect(await undoTurnFile("稿/新.docx")).toBe("已把第 2 轮新建的 稿/新.docx 移到废纸篓。");
    expect(h.files.has("稿/新.docx")).toBe(false);
    expect(useAgent.getState().turnChanges).toBeNull();
    expect(transcriptText()).toContain("移到废纸篓");
  });

  it("整份撤回：轮后又被改过的不动，留在本轮改动里", async () => {
    h.files.set("稿/报告.docx", "原文");
    await startSession();
    sendPrompt("写 稿/报告.docx 改过了");
    await until(() => useAgent.getState().turnChanges !== null);
    h.files.set("稿/报告.docx", "我后来又改的");
    expect(await undoTurnFile("稿/报告.docx")).toBe("稿/报告.docx 在第 1 轮之后又被改过，没动。");
    expect(h.files.get("稿/报告.docx")).toBe("我后来又改的");
    expect(useAgent.getState().turnChanges!.files).toEqual([{ path: "稿/报告.docx", status: "modified" }]);
  });

  it("权限：请求进店 → 用户允许 → 工具完成", async () => {
    await startSession();
    sendPrompt("请用工具");
    await until(() => useAgent.getState().permission !== null);
    expect(useAgent.getState().permission?.options.map((o) => o.optionId)).toEqual([
      "allow",
      "reject",
    ]);
    resolvePermission("allow");
    await until(() => transcriptText().includes("工具已执行"));
    const tool = useAgent.getState().transcript.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ status: "completed" });
    expect(useAgent.getState().permission).toBeNull();
  });

  it("取消：慢轮中途 cancel → stopReason=cancelled → 回就绪", async () => {
    await startSession();
    sendPrompt("慢");
    await until(() => transcriptText().includes("块1"));
    cancelTurn();
    await until(() => useAgent.getState().status === "ready");
    expect(transcriptText()).toContain("已取消这一轮");
  });

  it("auth_required：登录后重试建会话", async () => {
    h.state.spawn = () => makeFakeProc({ authFirst: true });
    await startSession();
    expect(useAgent.getState().status).toBe("auth");
    expect(useAgent.getState().authMethods.map((m) => m.id)).toEqual(["login"]);
    await authenticate("login");
    expect(useAgent.getState().status).toBe("ready");
  });

  it("切换模式：乐观更新 currentModeId", async () => {
    await startSession();
    setSessionMode("yolo");
    await until(() => useAgent.getState().modes?.currentModeId === "yolo");
  });

  it("换文库 = 会话立即作废", async () => {
    await startSession();
    expect(useAgent.getState().status).toBe("ready");
    useApp.setState({ lib: { root: "/别的地方", name: "别库" } });
    await until(() => useAgent.getState().status === "idle");
  });

  it("available_commands_update 进状态（skills 可见），不进转写", async () => {
    await startSession();
    sendPrompt("列命令");
    await until(() => useAgent.getState().commands.length === 1);
    expect(useAgent.getState().commands[0]).toEqual({ name: "hello-openfile", description: "演示 skill" });
    expect(transcriptText()).not.toContain("hello-openfile");
  });

  it("usage_update 进状态（上下文占用 + 累计花费），不进转写", async () => {
    await startSession();
    expect(useAgent.getState().usage).toBeNull();
    sendPrompt("用量");
    await until(() => useAgent.getState().usage !== null);
    expect(useAgent.getState().usage).toEqual({ used: 42_000, size: 200_000, cost: { amount: 1.25, currency: "USD" } });
    expect(transcriptText()).not.toContain("42");
  });

  it("_auth/status_update 未登录 → authNote + 转写里给登录提示", async () => {
    await startSession();
    expect(useAgent.getState().authNote).toBeNull();
    sendPrompt("未登录");
    await until(() => useAgent.getState().authNote === "Not logged in");
    expect(transcriptText()).toContain("claude login");
  });

  it("自定义命令：空命令给出人话错误", async () => {
    useAgent.setState({ presetId: "custom", customCmd: "   " });
    await startSession();
    expect(useAgent.getState().status).toBe("error");
    expect(useAgent.getState().error).toContain("自定义命令");
  });

  it("可见正文落到唯一纯文本档案，结束等待最后写入且排除思考/启动参数", async () => {
    await startSession();
    sendPrompt("私密诊断");
    await until(() => useAgent.getState().status === "ready");
    await stopSession();
    const first = useAgent.getState().archive!;
    expect(first.status).toBe("saved");
    expect(first.path).toMatch(/^会话\/内嵌\/.*\.md$/);
    const saved = h.files.get(first.path)!;
    expect(saved).toContain("## 用户\n\n私密诊断");
    expect(saved).toContain("只保存这条可见回复");
    expect(saved).not.toContain("SECRET_THOUGHT");
    expect(saved).not.toContain("--yes");
    await startSession();
    expect(useAgent.getState().archive?.path).not.toBe(first.path);
    expect(h.files.get(first.path)).toBe(saved);
  });

  it("文件夹还不是文库：档案存应用数据目录，文件夹里不写", async () => {
    h.state.inLibrary = false;
    await startSession();
    sendPrompt("非文库里的会话");
    await until(() => useAgent.getState().status === "ready");
    await stopSession();
    const archive = useAgent.getState().archive!;
    expect(archive).toMatchObject({ status: "saved", inLibrary: false });
    expect(archive.path).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}\.md$/);
    expect(h.appFiles.get(archive.path)).toContain("## 用户\n\n非文库里的会话");
    expect(h.writes).toEqual([]);
    expect([...h.files.keys()].some((k) => k.startsWith("会话/"))).toBe(false);
  });

  it("应用数据目录里的历史：照常引用进下一轮，不进可打开的引用来源，新档案记下来源", async () => {
    h.state.inLibrary = false;
    const name = "2026-10-21T03-04-05-678Z-0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.md";
    h.appFiles.set(name, "# 老会话\n\n过去讨论了页边。");
    await startSessionFromHistory(name, true);
    expect(useAgent.getState().historyContext).toMatchObject({ path: name, appData: true });
    sendPrompt("接着聊页边");
    await until(() => useAgent.getState().status === "ready");
    expect(transcriptText()).toContain(`来源: 应用数据/${name}`);
    expect(useAgent.getState().contextSources).not.toContain(name);
    await stopSession();
    expect(h.appFiles.get(useAgent.getState().archive!.path)).toContain(`- 历史来源: 应用数据/${name}`);
    expect(h.appFiles.get(name)).toBe("# 老会话\n\n过去讨论了页边。");
  });

  it("保存失败可见且不丢转写，修复后重试保存最新正文", async () => {
    await startSession();
    h.state.writeError = true;
    sendPrompt("需要保留这轮");
    await until(() => useAgent.getState().status === "ready");
    expect(await flushSessionArchive()).toBe(false);
    expect(useAgent.getState().archive?.status).toBe("error");
    expect(useAgent.getState().archive?.error).toContain("磁盘已满");
    expect(transcriptText()).toContain("需要保留这轮");
    h.state.writeError = false;
    expect(await flushSessionArchive()).toBe(true);
    expect(h.files.get(useAgent.getState().archive!.path)).toContain("你说：需要保留这轮");
  });

  it("启动尚未返回时切库，迟到的进程被终止，不污染新库面板", async () => {
    let release!: (proc: AgentProcessHandle) => void;
    h.state.spawn = () => new Promise((resolve) => { release = resolve; });
    const start = startSession();
    await until(() => !!release);
    const proc = makeFakeProc();
    const kill = vi.spyOn(proc, "kill");
    useApp.setState({ lib: { root: "/new-library", name: "new" } });
    release(proc);
    await start;
    expect(kill).toHaveBeenCalledOnce();
    expect(useAgent.getState().status).toBe("idle");
    expect(useAgent.getState().transcript).toEqual([]);
    expect(useAgent.getState().archive).toBeNull();
  });

  it("正常切库先落盘，保存失败拒绝调用后端切库", async () => {
    await startSession();
    sendPrompt("切库前的最后一句");
    await until(() => useAgent.getState().status === "ready");
    const path = useAgent.getState().archive!.path;
    h.state.writeError = true;
    await expect(useApp.getState().setLibraryPath("/next")).rejects.toThrow("尚未保存");
    expect(h.libraryChanges).toEqual([]);
    expect(useApp.getState().lib?.root).toBe(ROOT);
    h.state.writeError = false;
    await useApp.getState().setLibraryPath("/next");
    expect(h.files.get(path)).toContain("切库前的最后一句");
    expect(h.files.get(path)).toContain("- 状态: idle");
    expect(h.libraryChanges).toEqual(["/next"]);
    expect(useAgent.getState().archive).toBeNull();
    expect(useAgent.getState().transcript).toEqual([]);
  });

  it("显式历史引用创建新会话，等待用户发话且不改旧档案", async () => {
    const path = "会话/导入/过去.md";
    h.files.set(path, "# 老会话\n\n过去讨论了排版。");
    await startSessionFromHistory(path);
    expect(useAgent.getState().status).toBe("ready");
    expect(useAgent.getState().historyContext?.path).toBe(path);
    expect(useAgent.getState().transcript.some((item) => item.kind === "user")).toBe(false);
    sendPrompt("继续讨论正文宽度");
    await until(() => useAgent.getState().status === "ready");
    expect(transcriptText()).toContain("不是原生恢复");
    expect(h.files.get(path)).toBe("# 老会话\n\n过去讨论了排版。");
    expect(useAgent.getState().contextSources).toContain(path);
    expect(useAgent.getState().historyContext).toBeNull();
  });
});

describe("Gemini CLI 个人账号通道停用的识别", () => {
  it("认得 Google 返回的那句英文，不误伤普通登录错误", async () => {
    const { GEMINI_RETIRED } = await import("./agent-controller");
    expect(GEMINI_RETIRED.test("Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.")).toBe(true);
    expect(GEMINI_RETIRED.test("Authentication required")).toBe(false);
  });
});
