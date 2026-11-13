// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

describe("native history imports keep project boundaries", () => {
  it("defaults to matching cwd, skips unknown projects, and supports an explicit all-projects choice", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openfile-import-scope-")));
    const home = path.join(tmp, "home");
    const root = path.join(tmp, "library");
    const project = path.join(tmp, "project");
    const sessions = path.join(home, ".codex", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(root); fs.mkdirSync(project);
    for (const [id, cwd, text] of [["mine", project, "PROJECT_MATCH"], ["other", tmp, "OTHER_PROJECT_SECRET"], ["unknown", undefined, "UNKNOWN_PROJECT"]]) {
      const records = [
        { type: "session_meta", payload: { id, cwd, timestamp: "2026-09-12T08:00:00Z" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
      ];
      fs.writeFileSync(path.join(sessions, `${id}.jsonl`), records.map(x => JSON.stringify(x)).join("\n"));
    }
    const run = (...args) => execFileSync(process.execPath, ["scripts/session-import.mjs", "--root", root, "--project", project, "--source", "codex", ...args], {
      cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8",
    });
    try {
      const listing = run("--list");
      expect(listing).toContain("PROJECT_MATCH");
      expect(listing).not.toContain("OTHER_PROJECT_SECRET");
      expect(listing).not.toContain("UNKNOWN_PROJECT");
      expect(fs.readdirSync(root)).toEqual([]);
      const all = run("--list", "--all-projects");
      expect(all).toContain("OTHER_PROJECT_SECRET");
      expect(all).toContain("UNKNOWN_PROJECT");
      run();
      const imported = fs.readdirSync(path.join(root, "会话/导入"));
      expect(imported.filter(n => n !== "索引.md")).toHaveLength(1);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
