// @vitest-environment node
/** 桌面 sidecar 传输 `openfile serve --stdio`——真拉起进程，走行分隔 JSON-RPC。 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/paths";

const CLI = path.resolve(import.meta.dirname, "../packages/runtime/src/cli.ts");

interface Frame {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: { status?: number } };
  params?: Record<string, unknown>;
}

function startSidecar(settings: string, appData: string) {
  const child = spawn(process.execPath, [CLI, "serve", "--stdio", "--settings", settings], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENFILE_APPDATA: appData },
  });
  const frames: Frame[] = [];
  const raw: string[] = [];
  readline.createInterface({ input: child.stdout! }).on("line", (line) => {
    raw.push(line);
    frames.push(JSON.parse(line));
  });
  let next = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++next;
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const t0 = Date.now();
    for (;;) {
      const f = frames.find((x) => x.id === id);
      if (f) return f;
      if (Date.now() - t0 > 15_000) throw new Error(`等待 ${method} 超时`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const waitEvent = async (pred: (p: Record<string, unknown>) => boolean, ms = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      const f = frames.find((x) => x.method === "event" && x.params && pred(x.params));
      if (f) return f.params!;
      if (Date.now() - t0 > ms) throw new Error("等待事件超时");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { child, call, waitEvent, raw };
}

let running: ChildProcess | null = null;
afterEach(() => {
  running?.stdin?.end();
  running = null;
});

describe("openfile serve --stdio", () => {
  it("一个 sidecar 服务多个窗口：请求响应、错误码、按窗口推事件、设置落盘、stdin 关闭即退出", async () => {
    const base = tempDir("openfile-stdio-");
    const libA = path.join(base, "甲库");
    const libB = path.join(base, "乙库");
    fs.mkdirSync(libA);
    fs.mkdirSync(libB);
    fs.writeFileSync(path.join(libA, "a.md"), "# 甲\n");
    fs.writeFileSync(path.join(libB, "b.md"), "# 乙\n");
    const settings = path.join(base, "config", "settings.json");
    const s = startSidecar(settings, path.join(base, "appdata"));
    running = s.child;

    expect((await s.call("library.get", { ws: "w1" })).result).toBeNull();
    const noLib = await s.call("fs.list", { ws: "w1", rel: "" });
    expect(noLib.error?.data?.status).toBe(409);

    const a = (await s.call("library.open", { ws: "w1", path: libA })).result as { root: string; name: string };
    const b = (await s.call("library.open", { ws: "main", path: libB })).result as { root: string };
    expect(a.name).toBe("甲库");
    const listA = (await s.call("fs.list", { ws: "w1", rel: "" })).result as Array<{ name: string }>;
    const listB = (await s.call("fs.list", { ws: "main", rel: "" })).result as Array<{ name: string }>;
    expect(listA.map((e) => e.name)).toEqual(["a.md"]);
    expect(listB.map((e) => e.name)).toEqual(["b.md"]);

    // 绑定库根：拿 w2 的根去写 w1 → 409，零副作用
    const stale = await s.call("fs.write", { ws: "w1", rel: "x.md", content: "x", expectedRoot: b.root });
    expect(stale.error?.data?.status).toBe(409);
    expect(fs.existsSync(path.join(libA, "x.md"))).toBe(false);
    expect((await s.call("fs.readText", { ws: "w1", rel: "../乙库/b.md" })).error).toBeTruthy();
    expect((await s.call("no.such")).error?.data?.status).toBe(404);

    // 快照事件只带打快照的那个窗口
    const snap = (await s.call("snapshot.now", { ws: "main", label: "乙的第一版" })).result as { id: string };
    expect(snap.id).toMatch(/^[0-9a-f]{10}$/);
    const ev = await s.waitEvent((p) => p.type === "snapshot-created");
    expect(ev.ws).toBe("main");

    // 文件变更推到对应窗口
    fs.writeFileSync(path.join(libA, "new.md"), "新");
    const changed = await s.waitEvent((p) => p.type === "library-changed" && (p.paths as string[]).includes("new.md"));
    expect(changed.ws).toBe("w1");

    // 会话进程：输出与退出码经事件推送
    expect((await s.call("proc.spawnAgent", { ws: "w1", pid: "p1", cmd: process.execPath, args: ["-e", "console.log('hi'); process.exit(4)"] })).error).toBeUndefined();
    const exit = await s.waitEvent((p) => p.type === "proc" && p.pid === "p1" && p.stream === "exit");
    expect(exit.code).toBe(4);
    const out = await s.waitEvent((p) => p.type === "proc" && p.pid === "p1" && p.stream === "stdout");
    expect(Buffer.from(String(out.b64), "base64").toString()).toContain("hi");

    // 设置与 Rust 同键：recents（最新在前）、library（只记主窗口的）、autoSnapshot
    await s.call("snapshot.setAuto", { enabled: false });
    const saved = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(saved.recents.slice(0, 2)).toEqual([b.root, a.root]);
    expect(saved.library).toBe(b.root);
    expect(saved.autoSnapshot).toBe(false);
    expect((await s.call("snapshot.getAuto")).result).toBe(false);

    // stdout 每一行都是帧（日志不许混进来）
    expect(s.raw.every((l) => JSON.parse(l).jsonrpc === "2.0")).toBe(true);

    const exited = new Promise<number | null>((r) => s.child.on("exit", (c) => r(c)));
    s.child.stdin!.end();
    running = null;
    expect(await exited).toBe(0);
  }, 60_000);
});
