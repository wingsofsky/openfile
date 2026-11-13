/**
 * 文件管理的 JS 侧实现——dev 桥专用；语义对齐 src-tauri/src/fileops.rs，
 * 两边分叉时以 Rust 为准并回修这里。
 *
 * 与读写出证的关键差别：操作的是**目录项本身**，叶子处的符号链接绝不跟随
 * （resolveScoped 会把 AGENTS.md -> CLAUDE.md 解成 CLAUDE.md，拿去删/改名就动错了对象）。
 * 父目录走 resolveScoped（realpath、必在根内），叶子只接受一个普通成分；新目标永不覆盖。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { ScopeError, SKIP_DIRS, canonicalRoot, invalidOnWindows, resolveScoped } from "./scoped.mjs";

const PROTECTED_TOP = new Set([".openfile"]);
const INFO_WALK_CAP = 200_000;
const err = (s, m) => new ScopeError(s, m);
/** 内部目录名比较不分大小写：Windows / macOS 默认卷上 `.OPENFILE`、`.Git` 就是那个目录 */
const RESERVED_LOWER = new Set([...PROTECTED_TOP, ...SKIP_DIRS].map((n) => n.toLowerCase()));
const isReservedName = (name) => RESERVED_LOWER.has(String(name).toLowerCase());

function componentsOf(rel) {
  if (typeof rel !== "string" || rel.includes("\0")) throw err(400, "非法路径");
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("\\")) throw err(400, "不接受绝对路径");
  const out = [];
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw err(400, "路径包含越界成分");
    // 叶子不走 resolveScoped，这里补上同一套 Windows 名字规则：`w.md::$DATA`、`dir::$INDEX_ALLOCATION`
    // 是已有条目的 NTFS 流别名，放过去就能对着别名改名/删除
    if (invalidOnWindows(seg)) throw err(400, "非法文件名");
    out.push(seg);
  }
  return out;
}

function checkNotProtected(comps) {
  if (comps.length && isReservedName(comps[0])) throw err(403, "内部目录不在此处管理");
}

/**
 * 出证后再按规范路径查一遍：8.3 短名（OPENFI~1、GIT~1）与大小写变体在请求拼写里认不出，
 * 解析到磁盘上的真名才认得出。叶子若是链接，realpath 会落到链接目标——指向内部目录的链接也一并拒绝（宁严勿松）。
 */
function checkCanonicalNotProtected(root, abs) {
  let real;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    return; // 断链或已不存在：叶子本身由调用方处理
  }
  const rel = path.relative(canonicalRoot(root), real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return;
  checkNotProtected(rel.split(path.sep).filter(Boolean));
}

function validateName(name) {
  if (typeof name !== "string" || name === "" || name === "." || name === "..") throw err(400, "名称不能为空");
  if (name.includes("\0") || name.includes("/") || name.includes("\\")) throw err(400, "名称不能包含路径分隔符");
  if (Buffer.byteLength(name) > 255) throw err(400, "名称过长");
  if (name.trim() !== name) throw err(400, "名称首尾不能有空白");
  if (isReservedName(name)) throw err(400, "该名称保留给内部目录");
  if (invalidOnWindows(name)) throw err(400, "名称在 Windows 上不可用（含 : * ? \" < > | 等字符、以点结尾或是设备名）");
}

const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/** 已存在目录项：父目录出证 + 叶子不跟随链接；拒绝文库根 */
function resolveEntry(root, rel) {
  const comps = componentsOf(rel);
  checkNotProtected(comps);
  if (comps.length === 0) throw err(400, "不能对文库根执行此操作");
  const leaf = comps.pop();
  const parent = resolveScoped(root, comps.join("/"));
  const target = path.join(parent, leaf);
  if (!lstat(target)) throw err(404, "路径不可访问");
  checkCanonicalNotProtected(root, target);
  return target;
}

/** 新目录项：目标目录已存在且在根内；名字合法；目标处不能已有任何东西 */
function resolveNewChild(root, dirRel, name) {
  validateName(name);
  const comps = componentsOf(dirRel);
  checkNotProtected(comps);
  const dir = resolveScoped(root, comps.join("/"));
  checkCanonicalNotProtected(root, dir);
  if (!fs.statSync(dir).isDirectory()) throw err(400, "目标不是目录");
  const target = path.join(dir, name);
  if (lstat(target)) throw err(409, "目标已存在同名项");
  return target;
}

const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join("/");

function sameFile(a, b) {
  const x = lstat(a);
  const y = lstat(b);
  return !!x && !!y && x.dev === y.dev && x.ino === y.ino;
}

export function createDirAt(root, dirRel, name) {
  const target = resolveNewChild(root, dirRel, name);
  fs.mkdirSync(target);
  return relOf(root, target);
}

export function renameEntryAt(root, rel, newName) {
  const src = resolveEntry(root, rel);
  validateName(newName);
  const dest = path.join(path.dirname(src), newName);
  if (dest === src) return relOf(root, src);
  if (lstat(dest) && !sameFile(src, dest)) throw err(409, "目标已存在同名项");
  fs.renameSync(src, dest);
  return relOf(root, dest);
}

function checkNotIntoSelf(src, destDir) {
  const st = lstat(src);
  if (st?.isDirectory() && (destDir === src || destDir.startsWith(src + path.sep))) {
    throw err(400, "不能把文件夹放进它自己里面");
  }
}

export function moveEntryAt(root, rel, destDirRel) {
  const src = resolveEntry(root, rel);
  const destDir = resolveScoped(root, componentsOf(destDirRel).join("/"));
  if (path.dirname(src) === destDir) return relOf(root, src); // 原地：不动
  const dest = resolveNewChild(root, destDirRel, path.basename(src));
  checkNotIntoSelf(src, path.dirname(dest));
  fs.renameSync(src, dest);
  return relOf(root, dest);
}

function copyName(name, isDir, n) {
  const i = name.lastIndexOf(".");
  const [stem, ext] = !isDir && i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
  return n <= 1 ? `${stem} 副本${ext}` : `${stem} 副本 ${n}${ext}`;
}

/** 递归复制，不跟随也不复制符号链接 */
function copyTree(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    fs.mkdirSync(dest);
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dest, name));
  } else {
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  }
}

export function copyEntryAt(root, rel, destDirRel) {
  const src = resolveEntry(root, rel);
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) throw err(400, "不复制符号链接");
  const name = path.basename(src);
  let dest = null;
  for (let n = 0; n < 1000 && !dest; n++) {
    try {
      dest = resolveNewChild(root, destDirRel, n === 0 ? name : copyName(name, st.isDirectory(), n));
    } catch (e) {
      if (!(e instanceof ScopeError && e.status === 409)) throw e;
    }
  }
  if (!dest) throw err(409, "同名副本过多");
  checkNotIntoSelf(src, path.dirname(dest));
  try {
    copyTree(src, dest);
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true }); // 半截副本清掉（dest 是本次新建的）
    throw e;
  }
  return relOf(root, dest);
}

export function entryInfoAt(root, rel) {
  const target = resolveEntry(root, rel);
  const st = fs.lstatSync(target);
  let size = st.size;
  let items = null;
  let truncated = false;
  if (st.isDirectory()) {
    size = 0;
    items = 0;
    const stack = [target];
    walk: while (stack.length) {
      const dir = stack.pop();
      let names = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of names) {
        if (++items > INFO_WALK_CAP) {
          truncated = true;
          items = INFO_WALK_CAP;
          break walk;
        }
        const p = path.join(dir, d.name);
        if (d.isDirectory()) stack.push(p);
        else if (d.isFile()) size += lstat(p)?.size ?? 0;
      }
    }
  }
  return {
    name: path.basename(target),
    rel,
    isDir: st.isDirectory(),
    isSymlink: st.isSymbolicLink(),
    linkTarget: st.isSymbolicLink() ? fs.readlinkSync(target) : null,
    size,
    items,
    created: st.birthtimeMs > 0 ? Math.floor(st.birthtimeMs / 1000) : null,
    mtime: Math.floor(st.mtimeMs / 1000),
    readonly: (st.mode & 0o200) === 0,
    truncated,
  };
}

/**
 * 移到废纸篓（dev 桥）：macOS 直接 rename 进 ~/.Trash（同卷；没有访达的「放回原处」），
 * 别的平台 dev 模式不支持——桌面包走系统废纸篓（Rust trash crate）。
 * OPENFILE_TRASH_DIR 给 e2e 用，免得往开发者的废纸篓里倒测试夹具。
 */
export function trashEntryAt(root, rel) {
  const target = resolveEntry(root, rel);
  const trashDir = process.env.OPENFILE_TRASH_DIR || (process.platform === "darwin" ? path.join(os.homedir(), ".Trash") : null);
  if (!trashDir) throw err(501, "浏览器开发模式下只有 macOS 支持移到废纸篓；请用桌面版");
  const name = path.basename(target);
  let dest = path.join(trashDir, name);
  if (lstat(dest)) {
    const i = name.lastIndexOf(".");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    dest = path.join(trashDir, i > 0 ? `${name.slice(0, i)} ${stamp}${name.slice(i)}` : `${name} ${stamp}`);
  }
  try {
    fs.renameSync(target, dest);
  } catch (e) {
    throw err(500, `移到废纸篓失败: ${e.code === "EXDEV" ? "文库与废纸篓不在同一个卷" : e.message}`);
  }
}

/** 在访达 / 资源管理器里显示（路径先出证；空 rel = 文库根） */
export function revealEntryAt(root, rel) {
  const target = componentsOf(rel).length === 0 ? resolveScoped(root, "") : resolveEntry(root, rel);
  if (process.platform === "darwin") execFile("open", ["-R", target]);
  else if (process.platform === "win32") execFile("explorer.exe", [`/select,${target}`]);
  else execFile("xdg-open", [path.dirname(target)]);
}
