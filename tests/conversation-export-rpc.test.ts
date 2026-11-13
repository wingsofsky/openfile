// @vitest-environment node
/** History panel "Export chats" → runtime method conversations.export, through the real stdio sidecar and a fake HOME. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { expect, it } from "vitest";
import { tempDir } from "./helpers/paths";

const CLI = path.resolve(import.meta.dirname, "../packages/runtime/src/cli.ts");

function codexSession(dir: string, id: string, cwd: string, text: string) {
  const records = [
    { type: "session_meta", payload: { id, cwd, timestamp: "2026-10-22T08:00:00Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), records.map((x) => JSON.stringify(x)).join("\n"));
}

it("exports this folder's chats or all chats into Openfile's own archive, never into the folder", async () => {
  const base = fs.realpathSync(tempDir("openfile-export-rpc-"));
  const home = path.join(base, "home");
  const appData = path.join(base, "appdata");
  const folder = path.join(base, "folder");
  const sessions = path.join(home, ".codex", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "a.md"), "# a\n");
  codexSession(sessions, "mine", folder, "THIS_FOLDER_CHAT");
  codexSession(sessions, "other", base, "OTHER_PROJECT_CHAT");

  const child = spawn(process.execPath, [CLI, "serve", "--stdio", "--settings", path.join(base, "settings.json")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, USERPROFILE: home, OPENFILE_APPDATA: appData, OPENFILE_HOME: path.join(home, ".openfile") },
  });
  const frames: Array<{ id?: number; result?: unknown; error?: { message: string } }> = [];
  readline.createInterface({ input: child.stdout! }).on("line", (line) => frames.push(JSON.parse(line)));
  let next = 0;
  const call = async (method: string, params: Record<string, unknown>) => {
    const id = ++next;
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (const t0 = Date.now(); Date.now() - t0 < 30_000; await new Promise((r) => setTimeout(r, 20))) {
      const f = frames.find((x) => x.id === id);
      if (f) return f;
    }
    throw new Error(`waiting for ${method} timed out`);
  };
  const archived = (root: string) => {
    const dir = path.join(root, "会话", "导入");
    if (!fs.existsSync(dir)) return "";
    return fs.readdirSync(dir, { recursive: true }).map(String).filter((n) => n.endsWith(".md") && !n.endsWith("索引.md"))
      .map((n) => fs.readFileSync(path.join(dir, n), "utf8")).join("\n");
  };
  try {
    const opened = (await call("library.open", { ws: "w", path: folder })).result as { root: string };
    const archiveRoot = (await call("conversations.root", { ws: "w" })).result as string;
    expect(fs.existsSync(path.join(archiveRoot, ".openfile"))).toBe(true);
    expect(archiveRoot).toBe(fs.realpathSync(path.join(home, ".openfile")));

    const mine = (await call("conversations.export", { ws: "w", scope: "folder", expectedRoot: opened.root })).result as {
      ok: boolean; output: string; archiveRoot: string; summary: { found: boolean; exported: number; outside: number } | null;
    };
    expect(mine.ok).toBe(true);
    expect(mine.summary).toMatchObject({ found: true, exported: 1, outside: 1 });
    expect(mine.archiveRoot).toBe(archiveRoot);
    expect(archived(archiveRoot)).toContain("THIS_FOLDER_CHAT");
    expect(archived(archiveRoot)).not.toContain("OTHER_PROJECT_CHAT");

    const all = (await call("conversations.export", { ws: "w", scope: "all" })).result as { ok: boolean };
    expect(all.ok).toBe(true);
    expect(archived(archiveRoot)).toContain("OTHER_PROJECT_CHAT");

    expect(fs.readdirSync(folder)).toEqual(["a.md"]);
    expect((await call("conversations.export", { ws: "w", scope: "nope" })).error?.message).toMatch(/scope/);
  } finally {
    child.stdin!.end();
  }
}, 60_000);
