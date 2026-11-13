// @vitest-environment node
/** 运行时用安装包自带的 git（OPENFILE_GIT_DIR）时，配套环境只给 git 自己。 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitBinary, gitEnv } from "../packages/runtime/src/lib/git-bin.mjs";

const saved = { dir: process.env.OPENFILE_GIT_DIR, git: process.env.OPENFILE_GIT };
afterEach(() => {
  if (saved.dir === undefined) delete process.env.OPENFILE_GIT_DIR;
  else process.env.OPENFILE_GIT_DIR = saved.dir;
  if (saved.git === undefined) delete process.env.OPENFILE_GIT;
  else process.env.OPENFILE_GIT = saved.git;
});

describe("git-bin", () => {
  it("没带 git：PATH 上的 git（或 OPENFILE_GIT），环境原样", () => {
    delete process.env.OPENFILE_GIT_DIR;
    delete process.env.OPENFILE_GIT;
    expect(gitBinary()).toBe("git");
    const base = { PATH: "/usr/bin" };
    expect(gitEnv(base)).toBe(base);
    process.env.OPENFILE_GIT = "/opt/git/bin/git";
    expect(gitBinary()).toBe("/opt/git/bin/git");
  });

  it("带了 git：可执行文件与 GIT_EXEC_PATH 指进它的目录，不改调用方的环境对象", () => {
    const dir = path.resolve("/bundle/resources/git");
    process.env.OPENFILE_GIT_DIR = dir;
    const base = { PATH: "keep", HOME: "h" };
    const env = gitEnv(base);
    expect(base).toEqual({ PATH: "keep", HOME: "h" });
    expect(env.HOME).toBe("h");
    if (process.platform === "win32") {
      expect(gitBinary()).toBe(path.join(dir, "cmd", "git.exe"));
      expect(env.GIT_EXEC_PATH).toMatch(/libexec[\\/]git-core$/);
      expect(env.GIT_EXEC_PATH!.startsWith(dir)).toBe(true);
      expect(env.PATH!.endsWith(";keep")).toBe(true);
    } else {
      expect(gitBinary()).toBe(path.join(dir, "bin", "git"));
      expect(env.GIT_EXEC_PATH).toBe(path.join(dir, "libexec", "git-core"));
      expect(env.GIT_TEMPLATE_DIR).toBe(path.join(dir, "share", "git-core", "templates"));
      expect(env.GIT_CONFIG_SYSTEM).toBe(path.join(dir, "etc", "gitconfig"));
      expect(env.PATH).toBe("keep");
    }
  });
});
