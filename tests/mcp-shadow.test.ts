// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashRustStr,
  readWorktreeFromConfig,
  sanitizeName,
  initShadowAt,
  ShadowGit,
} from "../packages/runtime/src/mcp/shadow";
import { tempDir } from "./helpers/paths";

describe("影子仓库跨进程契约", () => {
  it("SipHash-1-3 与 Rust DefaultHasher 逐位一致（已有影子目录按它定位）", () => {
    // 常量钉死：改了算法，已有的影子目录就找不到了
    expect(hashRustStr("/tmp/openfile-测试库")).toBe("a426f32075a7167d");
    expect(hashRustStr("/Users/dev/Openfile")).toBe("59e088a75be63e14");
    expect(hashRustStr("C:\\Users\\dev\\库")).toBe("6ebe06554f968768");
  });

  it("sanitize 与 Rust 同口径（Unicode 字母数字保留、其余下划线、截 40）", () => {
    expect(sanitizeName("我的 文库-2026")).toBe("我的_文库_2026");
    expect(sanitizeName("x".repeat(50))).toHaveLength(40);
  });

  it("从裸仓库 config 抠 core.worktree", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-shadow-test-"));
    fs.writeFileSync(
      path.join(dir, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = /tmp/我的库\n[user]\n\tname = x\n",
    );
    expect(readWorktreeFromConfig(dir)).toBe("/tmp/我的库");
    expect(readWorktreeFromConfig(path.join(dir, "missing"))).toBeNull();
  });
});

describe("影子快照不保留本机认证状态", () => {
  it("独立子仓库即使没有提交也逐文件快照，Git 元数据保持原样", async () => {
    const tmp = tempDir("of-shadow-nested-");
    const root = path.join(tmp, "library"), dir = path.join(tmp, "shadow"), project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    execFileSync("git", ["init", "-q", project]);
    fs.writeFileSync(path.join(project, "code.txt"), "before\n");
    fs.writeFileSync(path.join(project, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(project, "ignored.txt"), "ignored\n");
    fs.writeFileSync(path.join(project, ".env"), "SYNTHETIC_SECRET\n");
    const metadata = () => fs.readdirSync(path.join(project, ".git"), { recursive: true }).map(String).sort()
      .filter((p) => fs.statSync(path.join(project, ".git", p)).isFile())
      .map((p) => [p, fs.readFileSync(path.join(project, ".git", p), "base64")]);
    const before = metadata();
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", dir, "--work-tree", root, ...args], { encoding: "utf8" });
    try {
      await initShadowAt(dir, root);
      const shadow = new ShadowGit(dir, root);
      const first = await shadow.snapshot("nested before");
      expect(git("show", "HEAD:project/code.txt")).toBe("before\n");
      const files = git("ls-tree", "-r", "--name-only", "HEAD");
      expect(files).not.toContain("ignored.txt"); expect(files).not.toContain(".env"); expect(files).not.toContain(".git/");
      fs.writeFileSync(path.join(project, "code.txt"), "after\n");
      expect(await shadow.diffSince(first!.id, "project/code.txt")).toContain("+after");
      await shadow.snapshot("nested after");
      expect(git("show", "HEAD:project/code.txt")).toBe("after\n");
      fs.unlinkSync(path.join(project, "code.txt"));
      await shadow.snapshot("nested deletion");
      expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("code.txt");
      expect(metadata()).toEqual(before);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    // A dozen real git processes: ~4s locally on Windows, more on CI runners — past the 5s default.
  }, 30_000);
  it("移除旧 index 中的敏感文件，新增敏感文件也不能被 .gitignore 反向放行", async () => {
    const tmp = tempDir("of-shadow-privacy-");
    const root = path.join(tmp, "library");
    const dir = path.join(tmp, "shadow");
    fs.mkdirSync(path.join(root, ".openfile/notes"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", dir, "--work-tree", root, ...args], { encoding: "utf8" });
    try {
      await initShadowAt(dir, root);
      fs.writeFileSync(path.join(root, ".env"), "SYNTHETIC_LEGACY_ONLY");
      git("add", "-f", "--", ".env");
      git("-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "legacy");
      const old = git("rev-parse", "HEAD").trim();
      for (const rel of [".openfile/settings.json", ".openfile/state.json", ".openfile/auth-state.json", ".openfile/local.pending.json", ".openfile/local.json", "credentials.json", "auth.json", "private.pem"]) fs.writeFileSync(path.join(root, rel), "SYNTHETIC_CURRENT_ONLY");
      fs.writeFileSync(path.join(root, ".gitignore"), "!.env\n!credentials.json\n!auth.json\n");
      fs.writeFileSync(path.join(root, ".openfile/notes/local.md"), "# Local task\n");
      fs.writeFileSync(path.join(root, ".openfile/notes/readme.md"), "# notes\n");
      await new ShadowGit(dir, root).snapshot("privacy boundary");
      const files = git("ls-tree", "-r", "--name-only", "HEAD");
      for (const name of [".env", "settings.json", "state.json", "local.pending.json", "local.json", "credentials.json", "auth.json", "private.pem"]) expect(files).not.toContain(name);
      expect(files).toContain(".openfile/notes/local.md");
      expect(files).toContain(".openfile/notes/readme.md");
      expect(git("show", `${old}:.env`)).toBe("SYNTHETIC_LEGACY_ONLY");
      expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe("SYNTHETIC_LEGACY_ONLY");
      const secret = "SYNTHETIC_CURRENT_ONLY";
      const blob = createHash("sha1").update(`blob ${Buffer.byteLength(secret)}\0${secret}`).digest("hex");
      expect(() => git("cat-file", "-e", blob)).toThrow(); // New credentials are not even staged as dangling blobs.
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, 30_000);
});
