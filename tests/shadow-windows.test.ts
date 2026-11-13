// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  ShadowGit,
  ensureShadowAttributes,
  findShadowDir,
  hashRustStr,
  initShadowAt,
  parseGitConfigValue,
  readWorktreeFromConfig,
  sanitizeName,
} from "../packages/runtime/src/mcp/shadow";

const tmps: string[] = [];
const tmp = (prefix: string) => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmps.push(d);
  return d;
};
const savedAppData = process.env.OPENFILE_APPDATA;
afterEach(() => {
  if (savedAppData === undefined) delete process.env.OPENFILE_APPDATA;
  else process.env.OPENFILE_APPDATA = savedAppData;
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("git config 值反转义（core.worktree 扫描兜底）", () => {
  it("首尾空白、引号、转义、注释", () => {
    expect(parseGitConfigValue(" /tmp/我的库")).toBe("/tmp/我的库");
    expect(parseGitConfigValue(" D:\\\\Openfile\\\\我的库")).toBe("D:\\Openfile\\我的库");
    expect(parseGitConfigValue(' "C:\\\\Users\\\\a b\\\\lib" ')).toBe("C:\\Users\\a b\\lib");
    expect(parseGitConfigValue(" /a/b   ; 注释")).toBe("/a/b");
    expect(parseGitConfigValue(' "/a #b" # 注释')).toBe("/a #b");
    expect(parseGitConfigValue(" a b ")).toBe("a b");
    expect(parseGitConfigValue(' "x\\"y"')).toBe('x"y');
    expect(parseGitConfigValue(" x\\ty")).toBe("x\ty");
  });

  it("非法转义 / 引号不闭合返回 null", () => {
    expect(parseGitConfigValue(" D:\\Openfile")).toBeNull(); // \O 不是合法转义：没反转义过的原文
    expect(parseGitConfigValue(' "unterminated')).toBeNull();
  });

  it("config 里转义过的 Windows 路径、CRLF 换行、大小写不同的节名", () => {
    const dir = tmp("of-shadow-cfg-");
    fs.writeFileSync(
      path.join(dir, "config"),
      "[Core]\r\n\trepositoryformatversion = 0\r\n\tbare = false\r\n\tworktree = D:\\\\Openfile\\\\我的库\r\n[user]\r\n\tname = x\r\n",
    );
    expect(readWorktreeFromConfig(dir)).toBe("D:\\Openfile\\我的库");
  });
});

describe("影子仓库：info/attributes", () => {
  it("整体写成固定的一行，幂等", () => {
    const dir = tmp("of-shadow-attr-");
    const line = "* -text -ident -filter -working-tree-encoding\n";
    ensureShadowAttributes(dir);
    expect(fs.readFileSync(path.join(dir, "info", "attributes"), "utf8")).toBe(line);
    fs.writeFileSync(path.join(dir, "info", "attributes"), "*.bin binary");
    ensureShadowAttributes(dir);
    expect(fs.readFileSync(path.join(dir, "info", "attributes"), "utf8")).toBe(line);
  });
});

describe("影子仓库：字节原样（Windows 的 Git 默认 core.autocrlf=true）", () => {
  it("即使仓库配置 autocrlf=true、文库自带 text=auto eol=lf，CRLF 文件也逐字节入库，diff 只标真改的行", async () => {
    const base = tmp("of-shadow-crlf-");
    const root = path.join(base, "library");
    const dir = path.join(base, "shadow");
    fs.mkdirSync(root);
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", dir, "--work-tree", root, ...args]);
    await initShadowAt(dir, root);
    expect(fs.readFileSync(path.join(dir, "info", "attributes"), "utf8")).toContain("* -text");
    git("config", "core.autocrlf", "true"); // 模拟 Git for Windows 的系统级默认
    fs.writeFileSync(path.join(root, ".gitattributes"), "* text=auto eol=lf\n");
    const original = "第一行\r\n第二行\r\n第三行\r\n";
    fs.writeFileSync(path.join(root, "a.md"), original);
    const shadow = new ShadowGit(dir, root);
    const first = await shadow.snapshot("crlf");
    expect(first).not.toBeNull();
    expect(git("cat-file", "-p", "HEAD:a.md").toString("utf8")).toBe(original);
    expect(await shadow.snapshot("无变化")).toBeNull(); // CRLF 不被当成「有改动」
    fs.writeFileSync(path.join(root, "a.md"), original.replace("第二行", "改过的第二行"));
    const diff = await shadow.diffSince(first!.id, "a.md");
    expect(diff).toContain("+改过的第二行");
    expect(diff).not.toContain("+第一行");
    expect(diff).not.toContain("+第三行");
  });
});

describe("影子仓库定位", () => {
  it("initShadowAt 写下的 core.worktree 读回来就是库根（Windows 上反斜杠被 git 转义存放）", async () => {
    const base = tmp("of-shadow-wt-");
    const root = path.join(base, "我的 库");
    fs.mkdirSync(root);
    await initShadowAt(path.join(base, "shadow"), root);
    expect(readWorktreeFromConfig(path.join(base, "shadow"))).toBe(root);
  });

  it("精确命中按 canonicalRoot 哈希；目录名不同时靠扫描 config 找回", async () => {
    const base = tmp("of-shadow-find-");
    const root = path.join(base, "lib");
    fs.mkdirSync(root);
    process.env.OPENFILE_APPDATA = path.join(base, "appdata");
    expect(findShadowDir(root)).toBeNull();
    const scanned = path.join(base, "appdata", "shadow", "别的名字-0000000000000000");
    await initShadowAt(scanned, root);
    expect(findShadowDir(root)).toEqual({ dir: scanned, kind: "app" });
    const exact = path.join(base, "appdata", "shadow", `${sanitizeName("lib")}-${hashRustStr(root)}`);
    await initShadowAt(exact, root);
    expect(findShadowDir(root)).toEqual({ dir: exact, kind: "app" });
  });

  it.runIf(process.platform === "win32")("Windows：\\\\?\\ 前缀的库根与 config 里带前缀的 worktree 都认", async () => {
    const base = tmp("of-shadow-unc-");
    const root = path.join(base, "lib");
    fs.mkdirSync(root);
    process.env.OPENFILE_APPDATA = path.join(base, "appdata");
    const exact = path.join(base, "appdata", "shadow", `${sanitizeName("lib")}-${hashRustStr(root)}`);
    await initShadowAt(exact, root);
    expect(findShadowDir(`\\\\?\\${root}`)).toEqual({ dir: exact, kind: "app" });
    // Rust（canonicalize）写进去的 worktree 可能带 \\?\ 前缀：扫描兜底剥掉再比
    fs.rmSync(exact, { recursive: true, force: true });
    const rustDir = path.join(base, "appdata", "shadow", "rust-written");
    fs.mkdirSync(rustDir, { recursive: true });
    fs.writeFileSync(path.join(rustDir, "HEAD"), "ref: refs/heads/main\n");
    const escaped = `\\\\?\\${root}`.replace(/\\/g, "\\\\");
    fs.writeFileSync(path.join(rustDir, "config"), `[core]\n\tbare = false\n\tworktree = ${escaped}\n`);
    expect(findShadowDir(root)).toEqual({ dir: rustDir, kind: "app" });
  });
});
