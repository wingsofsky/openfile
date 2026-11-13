// @vitest-environment node
// Windows 专属路径攻击面（scoped.mjs 与 Rust scope.rs 同口径）：反斜杠穿越、盘符相对路径、备用数据流、
// 设备保留名、首尾点/空格、8.3 短名别名、\\?\ 前缀。非 Windows 上只跑与平台无关的部分。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalRoot, plainWinPath, resolveScoped, resolveWritePathCreating } from "../packages/runtime/src/lib/scoped.mjs";
import { assertSafeSnapshotRestore } from "../packages/runtime/src/lib/sensitive-paths.mjs";
import { createDirAt, moveEntryAt, renameEntryAt } from "../packages/runtime/src/lib/file-ops.mjs";

const WIN = process.platform === "win32";
let base, root;
const status = (f) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e.status ?? "threw";
  }
};
const outsideEntries = () => fs.readdirSync(base).filter((n) => n !== "lib").sort();

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "of-scoped-win-")));
  root = path.join(base, "lib");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.mkdirSync(path.join(root, ".openfile"));
  fs.writeFileSync(path.join(root, ".openfile", "auth-state.json"), "{}");
  fs.writeFileSync(path.join(root, "a.md"), "x");
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe("scoped.mjs：平台无关的部分", () => {
  it("正常路径照常出证；/ 分隔的 .. 照旧拒绝", () => {
    expect(resolveScoped(root, "sub")).toBe(path.join(root, "sub"));
    expect(resolveWritePathCreating(root, "sub/new/x.md")).toBe(path.join(root, "sub", "new", "x.md"));
    expect(status(() => resolveWritePathCreating(root, "sub/../../x.md"))).toBe(400);
    expect(outsideEntries()).toEqual([]);
  });

  it("canonicalRoot 与 resolveScoped 同口径；plainWinPath 只在 Windows 上动 \\\\?\\ 前缀", () => {
    expect(canonicalRoot(root)).toBe(resolveScoped(root, ""));
    expect(plainWinPath("/Users/a")).toBe("/Users/a");
    if (WIN) {
      expect(plainWinPath("\\\\?\\D:\\lib")).toBe("D:\\lib");
      expect(plainWinPath("\\\\?\\UNC\\srv\\share\\lib")).toBe("\\\\srv\\share\\lib");
      expect(canonicalRoot(`\\\\?\\${root}`)).toBe(canonicalRoot(root));
    }
  });
});

describe.runIf(WIN)("scoped.mjs：Windows 攻击面", () => {
  it("反斜杠穿越：读、写、契约改写全拒，且库外零副作用（不先建目录）", () => {
    for (const rel of ["..\\x.md", "sub\\..\\..\\x.md", "sub/..\\..\\made\\y.md", "sub\\..\\..\\..\\made"]) {
      expect(status(() => resolveWritePathCreating(root, rel)), rel).toBe(400);
      expect(status(() => resolveScoped(root, rel)), rel).toBe(400);
    }
    expect(outsideEntries()).toEqual([]);
  });

  it("盘符路径、备用数据流、设备保留名、首尾点空格、非法字符都是非法路径", () => {
    for (const rel of ["C:x", "C:\\Windows", "c:/x", "a.md::$DATA", "a.md:secret", "sub/a.md:x", "CON", "nul.txt", "sub/COM1/x.md", "lpt9", "conin$", "a.md.", "sub /x.md", "a?.md", "a|b.md"]) {
      expect(status(() => resolveScoped(root, rel)), rel).toBe(400);
      expect(status(() => resolveWritePathCreating(root, rel)), rel).toBe(400);
    }
    expect(fs.readdirSync(root).sort()).toEqual([".openfile", "a.md", "sub"]);
  });

  it("快照恢复：备用数据流与盘符相对路径被拒且不打转（C:x 不能让向上回溯死循环）", () => {
    expect(() => assertSafeSnapshotRestore(root, ".openfile::$DATA")).toThrow();
    expect(() => assertSafeSnapshotRestore(root, "C:x")).toThrow();
    expect(() => assertSafeSnapshotRestore(root, "sub/C:x")).toThrow();
  });

  it("8.3 短名别名：出证结果是真名，快照恢复的敏感检查认得出来", () => {
    let short = null;
    try {
      short = resolveScoped(root, "OPENFI~1"); // 卷上关了 8.3 时这里 404，下面的断言不适用
    } catch {}
    if (short === null) return;
    expect(path.basename(short)).toBe(".openfile");
    expect(() => assertSafeSnapshotRestore(root, "OPENFI~1/auth-state.json")).toThrow(/快照恢复/);
  });

  it("大小写变体同样还原：.OPENFILE 下的本机配置不能经快照恢复改写", () => {
    expect(path.basename(resolveScoped(root, ".OPENFILE"))).toBe(".openfile");
    expect(() => assertSafeSnapshotRestore(root, ".OPENFILE/auth-state.json")).toThrow(/快照恢复/);
  });

  it("文件管理（dev 桥）：Windows 不可用的名字建不出来；内部目录的大小写变体与短名别名动不了；只改大小写的改名照常", () => {
    for (const name of ["CON", "aux.md", "a:b", "x.md.", "q?.md"]) {
      expect(status(() => createDirAt(root, "", name)), name).toBe(400);
      expect(status(() => renameEntryAt(root, "a.md", name)), name).toBe(400);
    }
    expect(status(() => renameEntryAt(root, ".OPENFILE", "x"))).toBe(403);
    expect(status(() => moveEntryAt(root, "a.md", ".OPENFILE"))).toBe(403);
    let short = null;
    try {
      short = resolveScoped(root, "OPENFI~1");
    } catch {}
    if (short !== null) {
      expect(status(() => renameEntryAt(root, "OPENFI~1", "x"))).toBe(403);
      expect(status(() => moveEntryAt(root, "a.md", "OPENFI~1"))).toBe(403);
    }
    expect(fs.existsSync(path.join(root, ".openfile", "auth-state.json"))).toBe(true);
    expect(renameEntryAt(root, "a.md", "A.md")).toBe("A.md");
    expect(fs.readdirSync(root)).toContain("A.md");
  });
});
