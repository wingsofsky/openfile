/**
 * 打包前装配桌面端自带的运行环境：官方 Node（Tauri externalBin）与 dugite-native 的 git（资源）。
 * 只在出安装包时跑（release.yml）；日常开发与 `pnpm tauri dev` 用 PATH 上的 node / git，不需要这一步。
 *
 *   node scripts/fetch-sidecars.mjs [--target <rust 目标三元组>]     缺省取 rustc 的宿主三元组
 *
 * 产出（都已 gitignore）：
 *   src-tauri/binaries/node-<三元组>[.exe]       → tauri.bundle.conf.json 的 externalBin，装好后在主程序旁边叫 node[.exe]
 *   src-tauri/resources/git/                    → 资源，运行时经 OPENFILE_GIT_DIR 用它打快照
 *   src-tauri/resources/licenses/               → 两者及 git 附带组件的许可原文、仓库根 THIRD-PARTY-NOTICES.md 的副本（随安装包分发）
 *
 * 下载包都按官方发布的 SHA-256 校验，不对就失败；缓存在 src-tauri/target/sidecar-cache/。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pruneGit } from "./prune-git.mjs";

const NODE_VERSION = "24.21.0";
// gitForWindows / lfs / gcm 是这个 tag 的 dependencies.json 里的版本（Windows 的 git 是 Git for Windows 的 MinGit，GCM 随它附带）；
// scripts/third-party-notices.mjs 从这里读版本
const DUGITE = { tag: "v2.53.0-4", build: "v2.53.0-4098283", gitForWindows: "v2.53.0.windows.4", lfs: "v3.7.1", gcm: "v2.9.0" };

// git 包里没带原文的许可：Git LFS 与 GCM 的许可文件；MinGit 的 MSYS2 / MinGW 工具（coreutils、grep、bash、gmp……，
// 清单在 git 包的 etc/package-versions.txt）用到的 GNU 许可，只随 Windows 包分发
const SPDX = "https://raw.githubusercontent.com/spdx/license-list-data/v3.29.0/text";
const LICENSE_TEXTS = [
  { name: "git-lfs-LICENSE.md", url: `https://raw.githubusercontent.com/git-lfs/git-lfs/${DUGITE.lfs}/LICENSE.md`, sha256: "4fae9062ab5cdd5fb15486b728534d8aded8b4ae9d84b6d66a956f5162c366b6" },
  { name: "git-credential-manager-LICENSE.txt", url: `https://raw.githubusercontent.com/git-ecosystem/git-credential-manager/${DUGITE.gcm}/LICENSE`, sha256: "b47f1a8a744ecdc7a3da35804f88552805d33f51a726b87a2105acdfae406b07" },
  { name: "GPL-3.0.txt", url: `${SPDX}/GPL-3.0-only.txt`, sha256: "fb981668c18a279e285fc4d83fba1e836cc84dd4daa73c9697d3cfd2d8aca6e0", windows: true },
  { name: "LGPL-3.0.txt", url: `${SPDX}/LGPL-3.0-only.txt`, sha256: "996af0513df21f7496288951c41428a03c174e9e4a9d63665c57d670f845ccb1", windows: true },
  { name: "LGPL-2.1.txt", url: `${SPDX}/LGPL-2.1-only.txt`, sha256: "5749785c8bdefafcb5d798270ed0a967036fe2ca63dcedade1627565dfef81d2", windows: true },
];

const TARGETS = {
  "x86_64-pc-windows-msvc": { node: "win-x64", archive: "zip", git: "windows-x64", exe: ".exe" },
  "aarch64-apple-darwin": { node: "darwin-arm64", archive: "tar.gz", git: "macOS-arm64", exe: "" },
  "x86_64-apple-darwin": { node: "darwin-x64", archive: "tar.gz", git: "macOS-x64", exe: "" },
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauri = path.join(repo, "src-tauri");
const cache = path.join(tauri, "target", "sidecar-cache");

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  return /^host: (.+)$/m.exec(out)?.[1]?.trim();
}

async function download(url, file) {
  if (fs.existsSync(file)) return;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, file);
}

async function text(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  return res.text();
}

function verify(file, expected) {
  const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expected.toLowerCase()) {
    fs.unlinkSync(file);
    throw new Error(`SHA-256 不符：${path.basename(file)}（期望 ${expected}，实际 ${actual}）`);
  }
}

/**
 * tar 解包。Windows 用系统自带的 bsdtar（System32\tar.exe，也认 zip）：PATH 上常是 Git 带的 GNU tar，
 * 它把 `D:\…` 里的冒号当成远程主机
 */
function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archive, "-C", dest], { stdio: "inherit" });
}

const argv = process.argv.slice(2);
const ti = argv.indexOf("--target");
const triple = ti === -1 ? hostTriple() : argv[ti + 1];
const t = TARGETS[triple];
if (!t) {
  console.error(`不支持的目标：${triple}（支持 ${Object.keys(TARGETS).join("、")}）`);
  process.exit(2);
}
fs.mkdirSync(cache, { recursive: true });
const licenses = path.join(tauri, "resources", "licenses");
fs.mkdirSync(licenses, { recursive: true });

// ---- Node ----
{
  const base = `node-v${NODE_VERSION}-${t.node}`;
  const name = `${base}.${t.archive}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}`;
  const file = path.join(cache, name);
  await download(url, file);
  const sums = await text(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`);
  const line = sums.split("\n").find((l) => l.trim().endsWith(`  ${name}`));
  if (!line) throw new Error(`SHASUMS256.txt 里没有 ${name}`);
  verify(file, line.split(/\s+/)[0]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "of-node-"));
  extract(file, tmp);
  const root = path.join(tmp, base);
  const bin = t.exe ? path.join(root, "node.exe") : path.join(root, "bin", "node");
  const out = path.join(tauri, "binaries", `node-${triple}${t.exe}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(bin, out);
  if (!t.exe) fs.chmodSync(out, 0o755);
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(licenses, "node-LICENSE.txt"));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(`node v${NODE_VERSION} → ${path.relative(repo, out)}`);
}

// ---- git（dugite-native） ----
{
  const name = `dugite-native-${DUGITE.build}-${t.git}.tar.gz`;
  const url = `https://github.com/desktop/dugite-native/releases/download/${DUGITE.tag}/${name}`;
  const file = path.join(cache, name);
  await download(url, file);
  verify(file, (await text(`${url}.sha256`)).trim().split(/\s+/)[0]);
  const dest = path.join(tauri, "resources", "git");
  fs.rmSync(dest, { recursive: true, force: true });
  extract(file, dest);
  const bin = t.exe ? path.join(dest, "cmd", "git.exe") : path.join(dest, "bin", "git");
  if (!fs.existsSync(bin)) throw new Error(`解包后找不到 ${path.relative(repo, bin)}`);
  if (!t.exe) {
    const { removed, bytes } = pruneGit(dest);
    console.error(`git 裁剪：删 ${removed} 项，省约 ${Math.round(bytes / 1048576)} MB（见 scripts/prune-git.mjs）`);
  }
  // Git 是 GPLv2：许可证原文随包分发（源码见 https://github.com/git/git 与 dugite-native 的同名 tag）
  const copying = ["LICENSE.txt", "COPYING"].map((f) => path.join(dest, f)).find((f) => fs.existsSync(f));
  const licenseOut = path.join(licenses, "git-LICENSE.txt");
  if (copying) fs.copyFileSync(copying, licenseOut);
  else {
    // macOS 包不带许可证：取 git 上游同版本 tag 的 COPYING
    const gitTag = DUGITE.tag.replace(/-\d+$/, "");
    const body = await text(`https://raw.githubusercontent.com/git/git/${gitTag}/COPYING`);
    if (!/GNU GENERAL PUBLIC LICENSE/.test(body)) throw new Error(`git ${gitTag} 的 COPYING 内容不对`);
    fs.writeFileSync(licenseOut, body);
  }
  console.error(`git ${DUGITE.build} → ${path.relative(repo, dest)}`);
}

// ---- 许可原文与第三方许可清单（清单由 scripts/third-party-notices.mjs 生成，提交在仓库根） ----
for (const l of LICENSE_TEXTS) {
  if (l.windows && !t.exe) continue;
  const file = path.join(cache, `license-${l.sha256.slice(0, 12)}-${l.name}`);
  await download(l.url, file);
  verify(file, l.sha256);
  fs.copyFileSync(file, path.join(licenses, l.name));
}
fs.copyFileSync(path.join(repo, "THIRD-PARTY-NOTICES.md"), path.join(licenses, "THIRD-PARTY-NOTICES.md"));
