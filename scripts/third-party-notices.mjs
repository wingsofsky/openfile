#!/usr/bin/env node
/**
 * 生成仓库根的 THIRD-PARTY-NOTICES.md：安装包里每个第三方组件的名称、版本、许可与许可全文。
 *
 *   node scripts/third-party-notices.mjs
 *
 * 输入：
 *   - npm：`pnpm licenses list --prod --json`（前端打进 dist 的依赖与运行时 sidecar 打进 cli.mjs 的依赖，工作区自己的包不算）
 *   - Rust：三个发版目标（Windows x64、macOS arm64 / x64）上 `cargo metadata` 的依赖图，从 openfile 出发只走普通依赖边
 *     （build / dev 依赖不进程序）
 *   - Node、git 与 git 附带的 Git LFS、GCM：版本取自 scripts/fetch-sidecars.mjs；许可原文由它放进 src-tauri/resources/licenses/
 *     随包分发，MinGit 里 MSYS2 / MinGW 组件自带的许可文件在随包的 resources/git 目录里
 * 许可全文取包里自带的 LICENSE / COPYING / NOTICE 类文件（含一层子目录，如 pdf.js 的字体与解码器）；一字不差的全文只印一次，
 * 各包按编号引用。包里没带许可文件的，按登记的许可标识指到同一许可的一份全文（版权归该包作者）。
 * 依赖变了就重跑，产物提交进仓库；scripts/fetch-sidecars.mjs 把它拷进安装包。
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(repo, "THIRD-PARTY-NOTICES.md");
const TARGETS = ["x86_64-pc-windows-msvc", "aarch64-apple-darwin", "x86_64-apple-darwin"];
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense)([-_.].*)?$/i;

/** 认出一份全文是哪种标准许可：给没带许可文件的包指一份同许可的全文 */
const STANDARD = [
  ["Apache-2.0", (b) => /Apache License\s+Version 2\.0, January 2004/.test(b) && /END OF TERMS AND CONDITIONS/.test(b)],
  ["MIT", (b) => /^(MIT License|The MIT License)/i.test(b) && /Permission is hereby granted, free of charge/.test(b)],
  ["BSD-3-Clause", (b) => /Redistribution and use in source and binary forms/.test(b) && /Neither the name/.test(b) && !/Apache License/.test(b)],
  ["Zlib", (b) => /provided ['‘]as-is['’], without any express or implied/.test(b) && /Altered source versions must be plainly marked/.test(b)],
  ["MPL-2.0", (b) => /^Mozilla Public License Version 2\.0/.test(b)],
  ["BSL-1.0", (b) => /Boost Software License - Version 1\.0/.test(b)],
];

/** 包目录里的许可类文件：根目录与一层子目录（跳过 node_modules） */
function licenseFiles(dir) {
  const out = [];
  const scan = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isFile() && LICENSE_FILE.test(e.name)) out.push(p);
      else if (e.isDirectory() && depth === 0 && e.name !== "node_modules") scan(p, 1);
    }
  };
  scan(dir, 0);
  return out;
}

/** 全文去重：规范换行与行尾空白后按内容哈希编号 */
const texts = new Map();
function textId(file) {
  const body = fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
  const hash = createHash("sha256").update(body).digest("hex");
  let entry = texts.get(hash);
  if (!entry) texts.set(hash, (entry = { id: `T${texts.size + 1}`, body }));
  return entry.id;
}

const link = (id) => `[${id}](#${id.toLowerCase()})`;

// ---- npm ----
function npmPackages() {
  // pnpm 在 Windows 上是 .cmd 垫片，经 shell 拉起；命令是写死的字面量
  const raw = execSync("pnpm licenses list --prod --json", { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  const out = [];
  for (const [license, list] of Object.entries(JSON.parse(raw))) {
    for (const p of list) {
      if (p.name.startsWith("@openfile/")) continue;
      p.versions.forEach((version, i) => out.push({ name: p.name, version, license, homepage: p.homepage, author: p.author, dir: p.paths[i] }));
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

// ---- Rust ----
function cratePackages() {
  const byId = new Map();
  for (const triple of TARGETS) {
    const meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1", "--filter-platform", triple, "--manifest-path", path.join(repo, "src-tauri", "Cargo.toml")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 256 * 1024 * 1024,
      }),
    );
    const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const seen = new Set([meta.resolve.root]);
    const queue = [meta.resolve.root];
    while (queue.length) {
      for (const dep of nodes.get(queue.shift())?.deps ?? []) {
        if (!dep.dep_kinds.some((k) => k.kind === null) || seen.has(dep.pkg)) continue;
        seen.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
    for (const id of seen) {
      if (id === meta.resolve.root) continue;
      const p = pkgs.get(id);
      const entry = byId.get(id) ?? {
        name: p.name,
        version: p.version,
        license: p.license ?? (p.license_file ? `见 ${p.license_file}` : "未登记"),
        homepage: p.repository ?? p.homepage ?? null,
        author: p.authors?.join(", ") || null,
        dir: path.dirname(p.manifest_path),
        targets: [],
      };
      entry.targets.push(triple);
      byId.set(id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

// ---- Node / git 版本 ----
const sidecars = fs.readFileSync(path.join(repo, "scripts", "fetch-sidecars.mjs"), "utf8");
const pick = (key) => {
  const v = new RegExp(`${key}[:=] "([^"]+)"`).exec(sidecars)?.[1];
  if (!v) throw new Error(`fetch-sidecars.mjs 里没找到 ${key}`);
  return v;
};
const nodeVersion = pick("NODE_VERSION ");
const dugiteTag = pick("tag");
const gfwTag = pick("gitForWindows");
const lfsTag = pick("lfs");
const gcmTag = pick("gcm");
const gitVersion = /^v(\d+\.\d+\.\d+)/.exec(dugiteTag)?.[1];

const npm = npmPackages();
const crates = cratePackages();
// 先收齐全部许可文件，再认标准许可（没带文件的包要指过去）
for (const p of [...npm, ...crates]) p.files = licenseFiles(p.dir).map((f) => ({ rel: path.relative(p.dir, f).replace(/\\/g, "/"), id: textId(f) }));
const standard = new Map();
for (const [spdx, test] of STANDARD) {
  const hit = [...texts.values()].find((t) => test(t.body));
  if (hit) standard.set(spdx, hit.id);
}

function describeFiles(p) {
  if (p.files.length) return p.files.map((f) => `\`${f.rel}\` → ${link(f.id)}`).join("，");
  const ids = [...new Set(p.license.split(/\s+(?:OR|AND|WITH)\s+|\/|[()]/).map((s) => s.trim()).filter(Boolean))];
  const refs = ids.map((id) => (standard.has(id) ? `${id} → ${link(standard.get(id))}` : `${id}（全文见 https://spdx.org/licenses/${id}.html）`));
  return `包里没有附带，按登记的许可适用，条款同 ${refs.join("、")}（版权归该包作者）`;
}

const ALL = TARGETS.length;
const section = (p) => {
  const lines = [`### ${p.name} ${p.version}`, "", `- 许可：${p.license}`];
  if (p.author) lines.push(`- 作者：${p.author}`);
  if (p.homepage) lines.push(`- 来源：${p.homepage}`);
  if (p.targets && p.targets.length !== ALL) lines.push(`- 只在这些目标上编入：${p.targets.join("、")}`);
  lines.push(`- 许可文件：${describeFiles(p)}`, "");
  return lines.join("\n");
};

const doc = [
  "# Third-party notices",
  "",
  "Openfile 本身以 Apache-2.0 发布（见 [LICENSE](LICENSE)）。安装包里还带着下列第三方组件，各自按其许可分发。",
  "本文件由 `node scripts/third-party-notices.mjs` 生成，不要手改；安装包里同一份在 `resources/licenses/THIRD-PARTY-NOTICES.md`。",
  "",
  "## 概览",
  "",
  `- Node.js ${nodeVersion}：桌面端的运行时 sidecar（官方构建，原样附带）`,
  `- Git ${gitVersion}（dugite-native ${dugiteTag}）：版本快照用的 git 命令行，连同 Git LFS、Git Credential Manager 与 Windows 版 MinGit 的运行库和工具`,
  `- npm 包 ${npm.length} 个：前端界面与运行时 sidecar 打包进去的依赖`,
  `- Rust crate ${crates.length} 个：编进桌面程序的依赖`,
  "",
  "## Node.js",
  "",
  `- 版本：${nodeVersion}（https://nodejs.org/dist/v${nodeVersion}/）`,
  "- 许可：MIT；Node.js 自带的第三方组件许可都在同一份 LICENSE 里",
  "- 许可全文：安装包里的 `resources/licenses/node-LICENSE.txt`（Node.js 发行包里的 LICENSE 原文）",
  "",
  "## Git 及其附带组件",
  "",
  `安装包里的 git 目录（\`resources/git\`）取自 dugite-native ${dugiteTag}（https://github.com/desktop/dugite-native/releases/tag/${dugiteTag}）。Openfile 只把它当独立程序调用，不链接其中任何代码。`,
  "",
  `- **Git ${gitVersion}**：GPL-2.0-only，许可全文 \`resources/licenses/git-LICENSE.txt\`。`,
  `  - Windows 版是 Git for Windows 的 MinGit ${gfwTag}（https://github.com/git-for-windows/git/releases/tag/${gfwTag}），源码 https://github.com/git-for-windows/git/tree/${gfwTag}，构建定义在 https://github.com/git-for-windows/MINGW-packages。`,
  `  - macOS 版由 dugite-native 从上游源码构建，源码 https://github.com/git/git/tree/v${gitVersion}，构建脚本 https://github.com/desktop/dugite-native/tree/${dugiteTag}。`,
  "  - 这两份 git 源码包与 dugite-native 构建脚本的源码包随本版本的 Release 一起提供。",
  `- **Git LFS ${lfsTag}**：MIT，其中取自 Go 的部分为 BSD-3-Clause，许可全文 \`resources/licenses/git-lfs-LICENSE.md\`。它依赖的 Go 模块各自的许可见源码 https://github.com/git-lfs/git-lfs/tree/${lfsTag}。`,
  `- **Git Credential Manager ${gcmTag}**：MIT，许可全文 \`resources/licenses/git-credential-manager-LICENSE.txt\`（源码 https://github.com/git-ecosystem/git-credential-manager/tree/${gcmTag}）。`,
  "- **Windows 版 MinGit 里的 MSYS2 / MinGW 组件**：运行库与命令行工具（curl、OpenSSL、PCRE2、zlib、expat、libiconv、coreutils、grep、sed、gawk、bash、OpenSSH 等），逐个的包名与版本见 `resources/git/etc/package-versions.txt`。",
  "  - 自带许可文件的在 `resources/git/mingw64/share/licenses/` 与 `resources/git/usr/share/licenses/`；用 GNU 标准许可的，全文在 `resources/licenses/GPL-3.0.txt`、`LGPL-3.0.txt`、`LGPL-2.1.txt`。",
  "  - 源码按包名与版本在 MSYS2 的源码仓库 https://repo.msys2.org/msys/sources/ 与 https://repo.msys2.org/mingw/sources/；Git for Windows 改过的包在 https://github.com/git-for-windows/MSYS2-packages 与 https://github.com/git-for-windows/MINGW-packages。",
  "",
  "## npm 包",
  "",
  ...npm.map(section),
  "## Rust crate",
  "",
  ...crates.map(section),
  "## 许可全文",
  "",
  "上面各包引用的许可文件全文。内容一字不差的只印一次。",
  "",
  ...[...texts.values()].flatMap((t) => [`<a id="${t.id.toLowerCase()}"></a>`, "", `### ${t.id}`, "", "```text", t.body.replace(/```/g, "``​`"), "```", ""]),
].join("\n");

fs.writeFileSync(OUT, doc.replace(/\n{3,}/g, "\n\n"));
const missing = [...npm, ...crates].filter((p) => !p.files.length);
console.error(
  `THIRD-PARTY-NOTICES.md：npm ${npm.length} 个，crate ${crates.length} 个（其中 ${missing.length} 个包里没带许可文件），全文 ${texts.size} 份，` +
    `标准许可 ${[...standard.keys()].join("、")}，${(Buffer.byteLength(doc) / 1024).toFixed(0)} KB`,
);
