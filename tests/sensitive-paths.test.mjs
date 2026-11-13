// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import cases from "./fixtures/sensitive-paths.json" with { type: "json" };
import { assertSafeSnapshotRestore, isSensitivePath } from "../packages/runtime/src/lib/sensitive-paths.mjs";
import { FILE_SYMLINK_SKIP, linkDir, linkFile } from "./helpers/links.ts";
import { tempDir } from "./helpers/paths.ts";

describe("快照敏感路径规则", () => {
  it.each(cases)("$path → $sensitive", ({ path, sensitive }) => {
    expect(isSensitivePath(path)).toBe(sensitive);
  });
  it("旧快照不能经目录/文件别名恢复本机配置，拒绝时不建目录", ({ annotate }) => {
    const root = tempDir("of-sensitive-alias-");
    try {
      fs.mkdirSync(path.join(root, ".openfile"));
      fs.writeFileSync(path.join(root, ".openfile/settings.json"), "SYNTHETIC_CURRENT");
      linkDir(path.join(root, ".openfile"), path.join(root, "alias"));
      const fileAlias = linkFile(path.join(root, ".openfile/settings.json"), path.join(root, "ordinary.json"));
      if (!fileAlias) void annotate(`ordinary.json file-alias case not exercised: ${FILE_SYMLINK_SKIP}`, "skip");
      for (const rel of ["alias/settings.json", "alias/auth-state.new.json", ...(fileAlias ? ["ordinary.json"] : []), "missing/.env", "../outside", "/tmp/outside", "bad\0path"]) {
        expect(() => assertSafeSnapshotRestore(root, rel), rel).toThrow();
      }
      expect(fs.existsSync(path.join(root, "missing"))).toBe(false);
      expect(() => assertSafeSnapshotRestore(root, "new/document.md")).not.toThrow();
      expect(fs.existsSync(path.join(root, "new"))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("控制目录本身是别名时也不能通过公开目录名经快照恢复改写", () => {
    const root = tempDir("of-sensitive-control-");
    try {
      fs.mkdirSync(path.join(root, "public-looking-state"));
      fs.writeFileSync(path.join(root, "public-looking-state/settings.json"), "SYNTHETIC_CURRENT");
      linkDir(path.join(root, "public-looking-state"), path.join(root, ".openfile"));
      expect(() => assertSafeSnapshotRestore(root, "public-looking-state/settings.json")).toThrow();
      expect(fs.existsSync(path.join(root, "public-looking-state/new"))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
