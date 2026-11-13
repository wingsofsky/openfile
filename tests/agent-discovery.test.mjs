// @vitest-environment node
/**
 * 可执行文件发现：按夹具 tests/fixtures/agent-discovery.json 建目录树，解释登记表的发现规则。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "@openfile/protocol/executor-registry";
import { discoverCandidates, expandPath, resolveEntryBin, whichOnPath } from "../packages/runtime/src/lib/agent-registry.mjs";
import fixture from "./fixtures/agent-discovery.json" with { type: "json" };

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

describe("可执行文件发现：共享目录树夹具", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "of-discover-"));
      try {
        const abs = (rel) => path.join(root, ...rel.split("/"));
        for (const rel of c.files) {
          fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
          fs.writeFileSync(abs(rel), "");
        }
        for (const [rel, t] of Object.entries(c.mtimes ?? {})) fs.utimesSync(abs(rel), t, t);
        const env = { ...Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, abs(v)])), PATH: c.path.map(abs).join(path.delimiter),
          // 登记表里的绝对目录（/opt/homebrew/bin 等）会读到本机真装的 CLI；只留主目录下的那几条，夹具才是全部真相
          OPENFILE_SEARCH_PATH: REGISTRY.searchPath.filter((r) => r.path.startsWith("~") && (!r.os || r.os.includes(c.platform))).map((r) => r.path).join(path.delimiter) };
        const ctx = { env, platform: c.platform, home: root };
        const rel = (p) => (p === null ? null : path.relative(root, p).split(path.sep).join("/"));
        const got = {};
        for (const e of REGISTRY.executors.filter((x) => x.bin)) {
          got[e.id] = {
            candidates: discoverCandidates(e.bin.discover, ctx).filter(isFile).map(rel),
            bin: rel(resolveEntryBin(e, ctx)),
          };
        }
        expect(got).toEqual(c.expect);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("可执行文件发现：路径展开与 PATH 规则", () => {
  it("~/、%LOCALAPPDATA% / %APPDATA%（缺省主目录下 AppData）、{exe} 按平台", () => {
    const home = path.join(os.tmpdir(), "h");
    expect(expandPath("~/.grok/bin/grok{exe}", { home, platform: "win32", env: {} })).toBe(path.join(home, ".grok", "bin", "grok.exe"));
    expect(expandPath("~/.grok/bin/grok{exe}", { home, platform: "darwin", env: {} })).toBe(path.join(home, ".grok", "bin", "grok"));
    expect(expandPath("%LOCALAPPDATA%/agy/bin/agy.exe", { home, platform: "win32", env: {} })).toBe(path.join(home, "AppData", "Local", "agy", "bin", "agy.exe"));
    expect(expandPath("%APPDATA%/Claude", { home, platform: "win32", env: { APPDATA: path.join(home, "R") } })).toBe(path.join(home, "R", "Claude"));
  });

  it("Windows 只认 .exe：无后缀 sh 垫片与 .cmd 不算；名字带 .exe 按原名找；其它平台按原名", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-which-"));
    try {
      for (const n of ["gemini", "gemini.cmd", "codex.exe"]) fs.writeFileSync(path.join(dir, n), "");
      expect(whichOnPath("gemini", { PATH: dir }, "win32")).toBeNull();
      expect(whichOnPath("codex", { Path: dir }, "win32")).toBe(path.join(dir, "codex.exe"));
      expect(whichOnPath("codex.exe", { PATH: dir }, "win32")).toBe(path.join(dir, "codex.exe"));
      expect(whichOnPath("gemini", { PATH: dir }, "darwin", { home: dir })).toBe(path.join(dir, "gemini"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
