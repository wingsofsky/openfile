// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { writeTextBound } from "../packages/runtime/src/api/workspace.ts";
import { tempDir } from "./helpers/paths.ts";

describe("library-bound background writes", () => {
  it("rejects stale roots, stale baselines and path attacks without writes", () => {
    const root = tempDir("openfile-bound-");
    const outside = tempDir("openfile-bound-out-");
    try {
      fs.writeFileSync(path.join(root, "note.md"), "original");
      expect(() => writeTextBound(root, "new/path.md", "private", outside)).toThrow(/文库/);
      expect(fs.existsSync(path.join(root, "new"))).toBe(false);
      expect(() => writeTextBound(root, "note.md", "lost", root, { content: "stale" })).toThrow(/更改/);
      expect(() => writeTextBound(root, "note.md", "lost", root, { content: null })).toThrow(/已存在/);
      expect(fs.readFileSync(path.join(root, "note.md"), "utf8")).toBe("original");
      fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
      for (const rel of ["../x.md", "/tmp/x.md", "x\0/a.md", "escape/new/x.md"]) {
        expect(() => writeTextBound(root, rel, "private", root, { content: null })).toThrow();
      }
      expect(fs.readdirSync(outside)).toEqual([]);
      writeTextBound(root, "note.md", "updated", root, { content: "original" });
      writeTextBound(root, "new/path.md", "created", root, { content: null });
      expect(fs.readFileSync(path.join(root, "note.md"), "utf8")).toBe("updated");
      expect(fs.readFileSync(path.join(root, "new/path.md"), "utf8")).toBe("created");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
