// @vitest-environment node
/**
 * 会话控制器在 Windows 文库上的路径纪律：真 SDK 双端在内存字节流上对接（不起子进程、不触盘）。
 * 文库根以 Rust canonicalize 的 `\\?\` 形式给出时，会话 cwd 必须是普通路径；agent 递来的
 * 反斜杠绝对路径要映射回库内相对路径，库外路径被拒且从不触达 backend。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  reads: [] as string[],
  writes: [] as Array<{ rel: string; content: string }>,
  cwds: [] as string[],
}));

vi.mock("../src/lib/backend", () => ({
  backend: {
    kind: "dev",
    listDir: async () => [],
    archiveInLibrary: async () => true,
    spawnAgent: () => Promise.resolve(makeFakeProc()),
    readText: async (rel: string) => {
      h.reads.push(rel);
      const content = h.files.get(rel);
      if (content === undefined) throw new Error("路径不可访问");
      return { content, size: content.length, truncated: false, encoding: "utf-8" };
    },
    writeText: async (rel: string, content: string) => {
      h.writes.push({ rel, content });
      h.files.set(rel, content);
    },
  },
}));

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type Agent, type ContentBlock } from "@agentclientprotocol/sdk";
import type { AgentProcessHandle } from "../src/lib/types";
import { useApp } from "../src/state/store";
import { useAgent } from "../src/state/agent";
import { sendPrompt, startSession, stopSession } from "../src/lib/agent-controller";

const ROOT = "\\\\?\\D:\\假机器\\文库";
const PLAIN = "D:\\假机器\\文库";

function makeFakeProc(): AgentProcessHandle {
  const stdoutCbs: Array<(b: Uint8Array) => void> = [];
  const exitCbs: Array<(c: number | null) => void> = [];
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toAgentWriter = toAgent.writable.getWriter();
  const fromAgent = new WritableStream<Uint8Array>({ write: (b) => stdoutCbs.forEach((cb) => cb(b)) });
  let cwd = "";
  const textOf = (blocks: ContentBlock[]) => blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
  const makeAgent = (conn: AgentSideConnection): Agent => ({
    initialize: async (p) => ({ protocolVersion: Math.min(p.protocolVersion, PROTOCOL_VERSION), agentInfo: { name: "假agent", version: "0" }, authMethods: [] }),
    authenticate: async () => ({}),
    newSession: async (p) => {
      cwd = p.cwd;
      h.cwds.push(p.cwd);
      return { sessionId: "s1" };
    },
    cancel: async () => undefined,
    prompt: async (p) => {
      const asked = textOf(p.prompt);
      const say = (text: string) =>
        conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
      const target = asked.startsWith("读 ") ? `${cwd}\\${asked.slice(2)}` : asked.startsWith("读绝对 ") ? asked.slice(4) : null;
      if (target) {
        try {
          await say(`读到:${(await conn.readTextFile({ sessionId: p.sessionId, path: target })).content}`);
        } catch (e) {
          await say(`读取被拒:${(e as Error).message}`);
        }
      } else if (asked.startsWith("写 ")) {
        await conn.writeTextFile({ sessionId: p.sessionId, path: `${cwd.replace(/\\/g, "/")}/${asked.slice(2)}`, content: "新内容" });
        await say("已写入");
      }
      return { stopReason: "end_turn" };
    },
  });
  void new AgentSideConnection(makeAgent, ndJsonStream(fromAgent, toAgent.readable));
  return {
    id: 1,
    write: async (data) => {
      await toAgentWriter.write(new TextEncoder().encode(data));
    },
    kill: async () => exitCbs.forEach((cb) => cb(0)),
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

const lastAssistant = () => {
  const items = useAgent.getState().transcript.filter((i) => i.kind === "assistant");
  const last = items[items.length - 1];
  return last && "text" in last ? last.text : "";
};

async function turn(text: string): Promise<string> {
  const before = useAgent.getState().transcript.length;
  sendPrompt(text);
  await until(() => useAgent.getState().status === "ready" && useAgent.getState().transcript.length > before + 1);
  return lastAssistant();
}

beforeEach(async () => {
  await stopSession();
  h.files.clear();
  h.reads.length = 0;
  h.writes.length = 0;
  h.cwds.length = 0;
  useApp.setState({ lib: { root: ROOT, name: "文库" } });
  useAgent.setState({ presetId: "claude", customCmd: "", historyContext: null });
});

afterAll(async () => {
  await stopSession();
});

describe("ACP 会话：Windows 文库根", () => {
  it("会话 cwd 是剥掉 \\\\?\\ 的普通路径", async () => {
    await startSession();
    await until(() => useAgent.getState().status === "ready");
    expect(h.cwds).toEqual([PLAIN]);
  });

  it("反斜杠 / 正斜杠绝对路径都映射回库内相对路径", async () => {
    h.files.set("docs/第一章.md", "正文");
    await startSession();
    await until(() => useAgent.getState().status === "ready");
    expect(await turn("读 docs\\第一章.md")).toBe("读到:正文");
    expect(await turn("写 docs/新.md")).toBe("已写入");
    expect(h.reads).toEqual(["docs/第一章.md"]);
    expect(h.writes.some((w) => w.rel === "docs/新.md" && w.content === "新内容")).toBe(true);
  });

  it("库外与 .. 爬出的路径被拒，且从不触达 backend", async () => {
    await startSession();
    await until(() => useAgent.getState().status === "ready");
    expect(await turn("读绝对 C:\\Windows\\win.ini")).toContain("读取被拒");
    expect(await turn("读绝对 D:\\假机器\\文库\\..\\隔壁\\秘密.md")).toContain("读取被拒");
    expect(h.reads).toEqual([]);
  });
});
