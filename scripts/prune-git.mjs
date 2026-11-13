/**
 * 裁掉安装包自带 git（dugite-native，macOS）里运行时用不上、打包时又会被展开的部分。
 *
 * 运行时只拿这份 git 在本机打影子快照、判敏感路径（lib/git-bin.mjs），不碰远程，也不给 agent 用。
 * dugite 的 libexec/git-core 里有 142 个指向 `git` 的符号链接（老式的 `git-add` 之类带横线入口），
 * Tauri 打资源时跟随链接，每个都复制成一份 3.4MB 的本体，安装包因此多出约 480MB；
 * 另有 Git Credential Manager 的 .NET 运行时（200 多个 dll / dylib）、git-lfs 与联网、服务端组件。
 * 内置命令在 git 进程内执行，删掉带横线入口不影响 `git add` 这种写法。
 *
 * Windows 的 MinGit 目录结构不同、也没在真机上量过，这里不动它。
 * 用法：node scripts/prune-git.mjs <git 目录>（fetch-sidecars 解包后自动调用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 联网、服务端、大文件与凭据组件：本机快照用不上 */
const DROP = new Set([
  "git-lfs", "scalar", "git-daemon", "git-shell", "git-imap-send",
  "git-http-backend", "git-http-fetch", "git-http-push",
  "git-remote-http", "git-remote-https", "git-remote-ftp", "git-remote-ftps",
  "git-credential-manager", "createdump", "uninstall.sh",
]);
/** Git Credential Manager 的 .NET 运行时 */
const DOTNET = /\.(dll|dylib|pdb)$|\.json$/;

/** @returns {{ removed: number, bytes: number }} 删了几项、按文件本体算省下多少字节（链接按打包后展开的本体计） */
export function pruneGit(dir) {
  const core = path.join(dir, "libexec", "git-core");
  const main = path.join(core, "git");
  if (!fs.existsSync(main)) throw new Error(`没有 ${path.relative(process.cwd(), main)}，不是 macOS 的 dugite git 目录`);
  const mainSize = fs.statSync(main).size;
  let removed = 0, bytes = 0;
  for (const name of fs.readdirSync(core)) {
    const p = path.join(core, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) continue;
    const toGit = st.isSymbolicLink() && fs.readlinkSync(p) === "git";
    if (!toGit && !DROP.has(name) && !DOTNET.test(name)) continue;
    bytes += toGit ? mainSize : st.isSymbolicLink() ? 0 : st.size;
    fs.unlinkSync(p);
    removed++;
  }
  return { removed, bytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("用法: node scripts/prune-git.mjs <git 目录>");
    process.exit(2);
  }
  const { removed, bytes } = pruneGit(path.resolve(dir));
  console.error(`git 裁剪：删 ${removed} 项，省约 ${Math.round(bytes / 1048576)} MB`);
}
