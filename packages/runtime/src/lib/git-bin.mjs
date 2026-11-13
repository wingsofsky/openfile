/**
 * 运行时调用的 git。影子快照、敏感路径检查都经这里，不各自写死 "git"。
 *
 * 选哪个：`OPENFILE_GIT_DIR`（安装包自带的 dugite-native git 目录，桌面宿主拉起 sidecar 时传入）→ `OPENFILE_GIT`
 * （显式指定一个 git 可执行文件）→ PATH 上的 `git`。
 *
 * 自带的 git 是可搬动的发行版，要配套环境变量才找得到自己的 git-core 与配置（同 dugite 的 setupEnvironment）。
 * 这些变量只给运行时自己拉的 git，不设在 sidecar 进程上：会话里的 agent CLI 继承了会把用户自己的 git 指错地方。
 */
import path from "node:path";

const WIN = process.platform === "win32";
/** Windows 上 dugite 的 MinGit 子目录（按架构） */
const winSub = () => (process.arch === "arm64" ? "clangarm64" : process.arch === "x64" ? "mingw64" : "mingw32");

export function gitBinary() {
  const dir = process.env.OPENFILE_GIT_DIR;
  if (dir) return WIN ? path.join(dir, "cmd", "git.exe") : path.join(dir, "bin", "git");
  return process.env.OPENFILE_GIT || "git";
}

/**
 * 拉 git 用的环境：没带自带 git 时原样返回 base；带了就补上 GIT_EXEC_PATH 等。
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(base = process.env) {
  const dir = process.env.OPENFILE_GIT_DIR;
  if (!dir) return base;
  const env = { ...base };
  if (WIN) {
    const sub = path.join(dir, winSub());
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = [path.join(sub, "bin"), path.join(sub, "usr", "bin"), env[key] ?? ""].join(";");
    env.GIT_EXEC_PATH = path.join(sub, "libexec", "git-core");
  } else {
    env.GIT_EXEC_PATH = path.join(dir, "libexec", "git-core");
    env.GIT_CONFIG_SYSTEM ??= path.join(dir, "etc", "gitconfig");
    env.GIT_TEMPLATE_DIR = path.join(dir, "share", "git-core", "templates");
    if (process.platform === "linux") env.PREFIX = dir;
  }
  return env;
}
