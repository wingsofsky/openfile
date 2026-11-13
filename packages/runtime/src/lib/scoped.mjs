/**
 * 库内路径安全层 —— JS 侧唯一实现，dev 桥（vite 中间件）与 MCP server 共用。
 * 语义与 src-tauri/src/scope.rs 一一对应（安全不变量同源）；
 * 若与 Rust 侧行为出现分叉，以 Rust 为准并回修此处。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fsp from "node:fs/promises";
import path from "node:path";

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  ".pnpm-store",
  ".Trash",
]);
export const SKIP_FILES = new Set([".DS_Store"]);
export const DEFAULT_TEXT_CAP = 4 * 1024 * 1024;
export const MAX_CAP = 64 * 1024 * 1024;

export class ScopeError extends Error {
  /**
   * @param {number} status HTTP 风格状态码（桥直接透传；MCP 侧只用 message）
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {number} s @param {string} m */
const err = (s, m) => new ScopeError(s, m);

const WIN = process.platform === "win32";
/**
 * realpath：Windows 用原生版——展开 8.3 短名（`OPENFI~1` → `.openfile`）、给出磁盘上的真实大小写，
 * 与 Rust `canonicalize` 同口径；JS 版 realpath 会原样保留短名，名字检查就能被别名绕过。
 */
const realpath = WIN ? fs.realpathSync.native : fs.realpathSync;
/** Windows 设备保留名（带不带扩展名都是设备）：写下去要么打开设备，要么建出资源管理器删不掉的文件 */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
/** `:` 一并拒绝——`a.md::$DATA` / `a.md:secret` 是 NTFS 备用数据流，`C:x` 是盘符相对路径 */
const WIN_BAD_CHAR_RE = /[<>:"|?*\u0000-\u001f]/;

/**
 * 库内相对路径 → 路径成分。与 Rust `Path::components` 对齐：Windows 上 `\` 也是分隔符；
 * `..`、绝对/盘符路径一律拒绝；Windows 上再拒非法文件名（备用数据流、设备名、首尾点/空格、非法字符）——
 * 这些名字在 Windows 上本来就建不出正常文件，拒掉不影响任何真实文档。
 * @param {unknown} rel
 * @returns {string[]}
 */
function relSegments(rel) {
  if (typeof rel !== "string" || rel.includes("\0")) throw err(400, "非法路径");
  if (path.isAbsolute(rel) || (WIN && /^[A-Za-z]:/.test(rel))) throw err(400, "不接受绝对路径");
  const segs = rel.split(WIN ? /[\\/]/ : "/").filter((s) => s !== "" && s !== ".");
  for (const seg of segs) {
    if (seg === "..") throw err(400, "路径包含越界成分");
    if (invalidOnWindows(seg)) throw err(400, "非法文件名");
  }
  return segs;
}

/** 单个路径成分在本机（Windows）上是否不可用；其它平台恒为 false。新建 / 改名的名字校验共用这一条 */
export function invalidOnWindows(seg) {
  return WIN && (WIN_BAD_CHAR_RE.test(seg) || WIN_RESERVED_RE.test(seg) || /[. ]$/.test(seg));
}

/**
 * Windows 扩展长度前缀（`\\?\D:\x`、`\\?\UNC\srv\share`）→ 普通形式。Rust 的 canonicalize 会带这个前缀，
 * 经命令行参数或界面传进 Node 后，fs.realpathSync 会 EISDIR；其它平台原样返回。
 */
export function plainWinPath(p) {
  if (!WIN || typeof p !== "string") return p;
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

/** 文库根的规范形式（同 resolveScoped 返回值的口径）；拿 path.relative 比较出证结果前先过一遍 */
export function canonicalRoot(root) {
  if (root === null) throw err(409, "尚未选择文库");
  try {
    return realpath(plainWinPath(root));
  } catch {
    throw err(409, "文库根不可访问");
  }
}

/**
 * 读路径出证：拒绝绝对路径 / `..` / NUL / 符号链接逃逸。目标必须已存在。
 * @param {string|null} root 文库根（绝对路径）
 * @param {string} rel 库内相对路径
 * @returns {string} canonical 绝对路径
 */
export function resolveScoped(root, rel) {
  if (root === null) throw err(409, "尚未选择文库");
  const segs = relSegments(rel);
  const rootReal = canonicalRoot(root);
  let real;
  try {
    real = realpath(path.join(rootReal, ...segs));
  } catch {
    throw err(404, "路径不可访问");
  }
  if (!within(rootReal, real)) throw err(403, "路径越出文库范围");
  return real;
}

/** real 是否就是 base 或在 base 之下（base 是盘符根 `D:\` 时也对） */
const within = (base, real) => real === base || real.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

/**
 * 写路径出证（可建缺失父目录）：从文库根逐段推进——已存在的段先 realpath
 * 验证仍在根内（符号链接指向库外时，在创建任何东西**之前**拒绝），不存在的段
 * 此后才逐层 mkdir（父已出证 + 段是普通成分 ⇒ 新目录必在根内）。
 * 与 Rust scope::resolve_write_path_creating 同算法。
 * @param {string|null} root
 * @param {string} rel
 * @returns {string} 可写的绝对目标路径（叶子可以不存在）
 */
export function resolveWritePathCreating(root, rel) {
  if (root === null) throw err(409, "尚未选择文库");
  // 成分校验在任何 mkdir 之前：Windows 上 `a/..\..\x` 这种段若漏过，path.join 会把它规范化到库外再建目录
  const comps = relSegments(rel);
  if (comps.length === 0) throw err(400, "非法文件名");
  const leaf = comps[comps.length - 1];
  const rootReal = canonicalRoot(root);
  let cur = rootReal;
  for (const seg of comps.slice(0, -1)) {
    const candidate = path.join(cur, seg);
    let existed = true;
    try {
      fs.lstatSync(candidate);
    } catch {
      existed = false;
    }
    if (!existed) {
      try {
        fs.mkdirSync(candidate);
      } catch (e) {
        // 并发创建（app 与 MCP server 同时写）：走已存在分支复验
        if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") existed = true;
        else throw err(500, `创建目录失败: ${/** @type {Error} */ (e).message}`);
      }
    }
    if (existed) {
      let real;
      try {
        real = realpath(candidate);
      } catch {
        throw err(404, "路径不可访问");
      }
      if (!within(rootReal, real)) throw err(403, "路径越出文库范围");
      if (!fs.statSync(real).isDirectory()) throw err(400, "父路径不是目录");
      cur = real;
    } else {
      cur = candidate;
    }
  }
  const target = path.join(cur, leaf);
  if (!within(rootReal, target)) throw err(403, "路径越出文库范围"); // 兜底：成分校验已保证，不该走到
  return target;
}

/**
 * Windows 上目标文件被别的进程开着（杀毒、索引、OneDrive、编辑器）时 rename 会 EPERM/EBUSY/EACCES，
 * 通常几十毫秒内就放开：短退避重试 5 次（合计约 0.6 秒），仍失败才报错。其它平台直接 rename。
 */
function renameRetrying(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (!WIN || i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 2 ** i);
    }
  }
}

/**
 * 持久化原子写：同目录临时文件 → fsync 文件 → rename → fsync 父目录。
 * rename 原子性保证监听器只见完整内容，且**替换**（而非跟随）目标处的符号链接；
 * 数据先 fsync 落盘，掉电后目标要么旧要么新，绝不空/半截。
 * 强度差异：此处是普通 fsync（Node 无 F_FULLFSYNC 直通），Rust 真身在
 * macOS 走 F_FULLFSYNC——本模块仅服务 dev 桥与 MCP，可接受。
 * @param {string} target 已出证的绝对路径
 * @param {string|Buffer} data
 */
export function atomicWriteFile(target, data) {
  const dir = path.dirname(target);
  const tmp = path.join(
    dir,
    `.openfile-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf-8") : data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameRetrying(tmp, target);
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 尽力关闭 */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 尽力清理 */
    }
    throw e;
  }
  // 目录 fsync 尽力而为：失败只缩不短崩溃窗口，不影响内容完整性
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* Windows 等平台打不开目录句柄 */
  }
}

/** WHATWG windows-1252 的 0x80–0x9F（未定义的 5 个字节映射到同值码位） */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
/**
 * 旧编码解码。Node 24.11 的 TextDecoder("windows-1252") 把 0x80–0x9F 当 latin1 解成 U+0080–U+009F
 * （「—」变控制字符）；按 WHATWG 表补正，与 Rust encoding_rs 一致。解码正确的 Node 上这步是空操作——
 * 正确结果里 U+0080–U+009F 只会出现那 5 个映射到自身的码位。
 */
function decodeLegacy(buf, encoding) {
  const text = new TextDecoder(encoding).decode(buf);
  if (encoding !== "windows-1252") return text;
  return text.replace(/[\u0080-\u009f]/g, (c) => String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80]));
}

/**
 * 读文本（带编码嗅探）：UTF-16 BOM → NUL 二进制嗅探 → utf-8 → chardetng。
 * 与 Rust 共用检测算法；tests/fixtures/text-encodings.json 约束两个版本的行为。
 * @param {string|null} root
 * @param {string} rel
 * @param {number} [max]
 * @returns {Promise<{content: string, size: number, truncated: boolean, encoding: string}>}
 */
export async function readTextScoped(root, rel, max) {
  const abs = resolveScoped(root, rel);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw err(400, "不是文件");
  const cap = Math.min(max ?? DEFAULT_TEXT_CAP, MAX_CAP, st.size);
  const fh = await fsp.open(abs, "r");
  let buf;
  try {
    buf = Buffer.alloc(cap);
    const { bytesRead } = await fh.read(buf, 0, cap, 0);
    buf = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const truncated = st.size > buf.length;
  // UTF-16 BOM 先于 NUL 嗅探（与 Rust scope.rs 对齐）
  if (buf.length >= 2) {
    const label =
      buf[0] === 0xff && buf[1] === 0xfe
        ? "utf-16le"
        : buf[0] === 0xfe && buf[1] === 0xff
          ? "utf-16be"
          : null;
    if (label) {
      let content = new TextDecoder(label).decode(buf);
      if (content.startsWith("﻿")) content = content.slice(1);
      return { content, size: st.size, truncated, encoding: label };
    }
  }
  // UTF-8 BOM：剥掉（TextDecoder utf-8 已自动剥，但显式对齐 Rust 行为）
  const body =
    buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      ? buf.subarray(3)
      : buf;
  const sniff = body.subarray(0, Math.min(8192, body.length));
  if (sniff.includes(0)) {
    return { content: "", size: st.size, truncated, encoding: "binary" };
  }
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return { content, size: st.size, truncated, encoding: "utf-8" };
  } catch {
    // Native Node import keeps WASM out of the desktop/frontend and the esbuild CLI bundle.
    // Node >=22.19 supports this without a process-wide experimental flag.
    const moduleUrl = pathToFileURL(createRequire(import.meta.url).resolve("chardetng-wasm/dist/chardetng_wasm.js")).href;
    const { EncodingDetector } = await import(/* @vite-ignore */ moduleUrl);
    const detector = EncodingDetector.new();
    try {
      detector.feed(buf, !truncated);
      const encoding = detector.guess(undefined, true).toLowerCase();
      const content = decodeLegacy(buf, encoding);
      return { content, size: st.size, truncated, encoding };
    } finally {
      detector.free();
    }
  }
}
