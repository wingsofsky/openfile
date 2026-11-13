#!/usr/bin/env node
/**
 * 黑盒 E2E：起真实 vite dev（含 dev-runtime：运行时 API 的 HTTP 传输），对着一个临时文库跑断言。
 * 后端是 packages/runtime/src/api/（桌面 sidecar 同一份）。下面的断言按 /__fs/* 路径写，由 fsCall() 翻成 /__rpc 方法调用；
 * 请求闸与 SSE 直接测 /__rpc 端点。
 * 覆盖：库设置 / 列目录 / 读文本(utf8+gbk+二进制+截断) / raw 流 / 搜索 /
 *      变更 SSE / 路径遍历与符号链接逃逸攻击 / Windows 路径形态（反斜杠穿越、盘符相对、备用数据流、设备名、尾点）。
 * 退出码非零 = 失败。用法：node scripts/e2e-bridge.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 1477;
const BASE = `http://127.0.0.1:${PORT}`;
const WIN = process.platform === "win32";
let failures = 0;
let vite = null;

function ok(cond, name, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

/** 目录链接：真符号链接；Windows 无开发者模式时（EPERM）退回 junction——同样经 realpath 解析、lstat 认作链接，不需要特权 */
function linkDir(target, link) {
  try {
    fs.symlinkSync(target, link, "dir");
  } catch (e) {
    if (WIN && e.code === "EPERM") fs.symlinkSync(target, link, "junction");
    else throw e;
  }
}

/** 文件符号链接：Windows 无开发者模式时建不了（EPERM）→ 返回 false，调用方只跳过依赖它的断言 */
function linkFile(target, link) {
  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch (e) {
    if (WIN && e.code === "EPERM") return false;
    throw e;
  }
}

/**
 * CSP 头 → 指令表（小写指令名 → 源列表；同名指令只认第一条，与浏览器一致）。逐条断言而不整串比较：
 * 本机的过滤代理会改写 127.0.0.1 响应的 CSP——追加指令、往指令里加自己的源
 * （例如 frame-src 末尾加 data:；原始文档的 sandbox 被加上 allow-scripts、default-src 换成代理自己的源）。
 */
function cspDirectives(header) {
  const map = new Map();
  for (const part of (header ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name && !map.has(name.toLowerCase())) map.set(name.toLowerCase(), sources);
  }
  return map;
}

/** 结束时收掉整棵 vite 进程树（Windows 上 kill() 只杀 node 本身，子进程会占着 strictPort） */
function stopVite() {
  if (!vite || vite.exitCode !== null || vite.signalCode !== null) return;
  if (WIN) spawnSync("taskkill", ["/T", "/F", "/PID", String(vite.pid)], { stdio: "ignore", windowsHide: true });
  else vite.kill("SIGTERM");
}

// 废纸篓改道：e2e 不往开发者的 ~/.Trash 里倒夹具
const TRASH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-trash-"));
// 影子仓库改道：快照夹具不进开发者真实的应用数据目录（app_data/shadow）
const APP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-appdata-"));

function makeFixture() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-lib-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-out-"));
  fs.mkdirSync(path.join(lib, "docs"));
  fs.mkdirSync(path.join(lib, ".git"));
  fs.mkdirSync(path.join(lib, ".claude"));
  fs.writeFileSync(path.join(lib, "hello.md"), "# 你好\n\n这是测试文档。\n");
  fs.writeFileSync(path.join(lib, "docs/report.html"), "<h1>report</h1>");
  fs.writeFileSync(path.join(lib, "docs/data.txt"), "plain text");
  fs.writeFileSync(path.join(lib, ".claude/memory.md"), "agent memory");
  fs.writeFileSync(path.join(lib, ".git/secret"), "should be hidden");
  fs.writeFileSync(path.join(lib, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(lib, "big.txt"), "x".repeat(1000));
  // 编码矩阵（F2：Rust chardetng vs JS 桥固定顺序，最高危分叉——两端各测）
  fs.writeFileSync(path.join(lib, "gbk.txt"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); // GBK 中文
  // UTF-16LE + BOM："记事本"
  const u16le = [0xff, 0xfe];
  for (const cp of "记事本") {
    const c = cp.codePointAt(0);
    u16le.push(c & 0xff, (c >> 8) & 0xff);
  }
  fs.writeFileSync(path.join(lib, "u16.txt"), Buffer.from(u16le));
  // UTF-8 + BOM 的 markdown：首行标题必须能被识别
  fs.writeFileSync(
    path.join(lib, "bom.md"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# 标题\n正文", "utf-8")]),
  );
  fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE");
  linkDir(outside, path.join(lib, "escape-link"));
  // 符号链接索引矩阵：库内文件链接（AGENTS.md → CLAUDE.md 场景）应入索引；
  // 库外文件链接不入；escape-link（库外目录链接）不被跟随。
  // Windows 无开发者模式时建不了文件符号链接（EPERM）：跳过这组断言而不是整套失败
  const fileLinks =
    linkFile(path.join(lib, "hello.md"), path.join(lib, "linked-note.md")) &&
    linkFile(path.join(outside, "secret.txt"), path.join(lib, "leak.md"));
  if (!fileLinks) console.log("  · 文件符号链接建不了（Windows 未开开发者模式）：跳过依赖它的断言；CI 是管理员，照跑");
  return { lib, outside, fileLinks };
}

async function waitReady(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/__rpc`, { method: "POST", headers: RPC_HEADERS, body: JSON.stringify({ method: "library.get" }) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("vite dev 未在超时内就绪");
}

const RPC_HEADERS = { "content-type": "application/json", "x-openfile-request": "1" };

/** /__fs/* 端点 → 运行时方法 + 参数（+ 结果改回断言用的形状） */
function fsCall(pathname, init) {
  const url = new URL(pathname, BASE);
  const q = (k) => url.searchParams.get(k) ?? undefined;
  const num = (k) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
  const body = init?.body ? JSON.parse(init.body) : {};
  const post = init?.method === "POST";
  const route = url.pathname.slice("/__fs/".length);
  const asRel = (r) => ({ rel: r });
  switch (route) {
    case "library": return post ? ["library.open", { path: body.path }] : ["library.get", {}];
    case "list": return ["fs.list", { rel: q("p") ?? "", expectedRoot: q("root") }];
    case "text": return ["fs.readText", { rel: q("p") ?? "", maxBytes: num("max"), expectedRoot: q("root") }];
    case "bin": return ["fs.readBinary", { rel: q("p") ?? "" }];
    case "stat": return ["fs.stat", { rel: q("p") ?? "" }];
    case "write": return ["fs.write", { rel: body.path, content: body.content, expectedRoot: body.expectedRoot, expectedContent: body.expectedContent }];
    case "search": return ["index.search", { query: q("q") ?? "", limit: num("limit") }];
    case "reindex": return ["index.rebuild", {}];
    case "indexcount": return ["index.count", {}, (count) => ({ count })];
    case "recents": return ["library.recents", {}];
    case "ver/snapshot": return ["snapshot.now", { label: body.label }];
    case "ver/list": return ["snapshot.list", { limit: num("limit") }];
    case "ver/changes": return ["snapshot.changes", { id: q("id"), from: q("from") }];
    case "ver/file": return ["snapshot.diffFile", { path: q("path"), from: q("from"), to: q("to") }];
    case "ver/bin": return ["snapshot.readB64", { id: q("id"), path: q("path") }];
    case "ver/restorefile": return ["snapshot.restoreFile", { id: body.id, path: body.path }];
    case "ver/restoresnap": return ["snapshot.restore", { id: body.id }];
    case "ver/auto": return post ? ["snapshot.setAuto", { enabled: body.enabled }] : ["snapshot.getAuto", {}, (enabled) => ({ enabled })];
    case "fileop": {
      const { op, ...rest } = body;
      return [`fileop.${op}`, rest, ["mkdir", "rename", "move", "copy"].includes(op) ? asRel : undefined];
    }
    default: throw new Error(`e2e：没有对应的运行时方法 ${pathname}`);
  }
}

async function rpc(method, params = {}, headers = RPC_HEADERS, signal) {
  const r = await fetch(`${BASE}/__rpc`, { method: "POST", headers, body: JSON.stringify({ method, params }), signal });
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, body, headers: r.headers };
}

async function j(pathname, init) {
  const [method, params, wrap] = fsCall(pathname, init);
  const r = await rpc(method, params);
  if (r.status !== 200) return r;
  const result = r.body?.result ?? null;
  return { ...r, body: wrap && result !== null ? wrap(result) : result };
}

async function main() {
  const { lib, outside, fileLinks } = makeFixture();
  console.log(`fixture 文库: ${lib}`);

  // spawn node + vite.js directly: "pnpm" is a .cmd/.ps1 shim on Windows, un-spawnable without a shell
  const viteBin = path.resolve(import.meta.dirname, "..", "node_modules", "vite", "bin", "vite.js");
  vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, OPENFILE_LIBRARY: "", OPENFILE_TRASH_DIR: TRASH_DIR, OPENFILE_APPDATA: APP_DATA },
    stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stderr.on("data", (d) => process.env.E2E_VERBOSE && console.error(String(d)));
  await waitReady();

  const shell = await fetch(BASE);
  {
    // 我们给出的四个源都在，且只有本地源（代理追加的 data: 之类无害）：没有 *、裸 http(s): 或任何别的主机。
    // 配置里的原值由 tests/html-csp-server.test.mjs 逐字钉住
    const header = shell.headers.get("content-security-policy");
    const frameSrc = cspDirectives(header).get("frame-src");
    const ours = ["'self'", "asset:", "http://asset.localhost", "blob:"];
    const localOnly = (s) => ours.includes(s) || /^(data|blob|filesystem|mediastream):$/i.test(s) || /^'(self|none)'$/i.test(s);
    ok(!!frameSrc && ours.every((s) => frameSrc.includes(s)) && frameSrc.every(localOnly), "父页面响应限制 iframe 远程导航", header);
  }

  console.log("\n[1] 库生命周期");
  ok((await j("/__fs/library")).body === null, "初始无库");
  const set = await j("/__fs/library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: lib }),
  });
  ok(set.status === 200 && set.body.name, "设置文库成功");
  ok((await j("/__fs/list?p=")).status === 200, "列根目录");

  console.log("[bound IO] 异步会话/记忆固定文库与写入基线");
  const pinnedRoot = set.body.root;
  const staleRoot = encodeURIComponent(pinnedRoot + "-other");
  ok((await j(`/__fs/text?p=hello.md&root=${staleRoot}`)).status === 409, "旧文库读取被拒");
  ok((await j(`/__fs/list?p=&root=${staleRoot}`)).status === 409, "旧文库列目录被拒");
  const boundWrite = (body) => j("/__fs/write", { method: "POST", body: JSON.stringify(body) });
  ok((await boundWrite({ path: "stale/background.md", content: "private", expectedRoot: pinnedRoot + "-other" })).status === 409, "旧会话写入被拒");
  ok(!fs.existsSync(path.join(lib, "stale")), "错误文库写入零副作用");
  ok((await boundWrite({ path: "bound.md", content: "first", expectedRoot: pinnedRoot, expectedContent: { content: null } })).status === 200, "显式新建");
  ok((await boundWrite({ path: "bound.md", content: "lost", expectedRoot: pinnedRoot, expectedContent: { content: null } })).status === 409, "新建不覆盖已有档案");
  ok((await boundWrite({ path: "bound.md", content: "lost", expectedRoot: pinnedRoot, expectedContent: { content: "stale" } })).status === 409, "旧基线不覆盖新内容");
  ok((await boundWrite({ path: "bound.md", content: "second", expectedRoot: pinnedRoot, expectedContent: { content: "first" } })).status === 200, "匹配基线可更新");
  ok(fs.readFileSync(path.join(lib, "bound.md"), "utf8") === "second", "最终持久内容正确");

  console.log("\n[security] 所有变更入口的请求边界");
  const probeWrite = (headers, filename) => fetch(`${BASE}/__rpc`, {
    method: "POST", headers,
    body: JSON.stringify({ method: "fs.write", params: { rel: filename, content: "synthetic CSRF fixture" } }),
  });
  const crossWrite = await probeWrite({ "content-type": "text/plain", origin: "http://127.0.0.1:1483" }, "csrf-form.md");
  ok(crossWrite.status === 403, "跨来源普通表单不能写入");
  ok(!fs.existsSync(path.join(lib, "csrf-form.md")), "拒绝跨来源写入无文件副作用");
  const noHeader = await probeWrite({ "content-type": "application/json" }, "csrf-header.md");
  ok(noHeader.status === 403, "缺少显式请求头不能写入");
  ok(!fs.existsSync(path.join(lib, "csrf-header.md")), "拒绝缺头写入无文件副作用");
  for (const method of ["library.open", "snapshot.setAuto", "snapshot.now", "snapshot.restoreFile", "snapshot.restore", "index.rebuild", "proc.spawnAgent"]) {
    const r = await rpc(method, { path: lib, enabled: false, pid: "x", cmd: "node", id: "codex" }, { ...RPC_HEADERS, origin: "http://evil.example" });
    ok(r.status === 403, `${method} 拒绝异源，即使声称带请求头`);
  }
  ok((await rpc("fs.readText", { rel: "hello.md" }, { ...RPC_HEADERS, origin: "http://evil.example" })).status === 403, "读取同样拒绝异源");
  ok((await fetch(`${BASE}/__rpc`, { method: "GET" })).status >= 400, "/__rpc 不接受 GET");
  ok((await fetch(`${BASE}/__rpc/events`, { headers: { origin: "http://evil.example" } })).status === 403, "事件流拒绝异源");

  console.log("\n[2] 列目录语义");
  const rootList = (await j("/__fs/list?p=")).body;
  const names = rootList.map((e) => e.name);
  ok(names.includes(".claude"), ".claude 可见（agent 记忆是一等内容）");
  ok(!names.includes(".git"), ".git 隐藏");
  ok(names.includes("docs") && rootList.find((e) => e.name === "docs").isDir, "目录标记正确");
  ok(rootList[0].isDir, "目录排前");
  // 列目录口径（与 Rust list_dir_at 对齐）：库外符号链接彻底隐藏，库内链接保留
  ok(!names.includes("escape-link"), "库外目录符号链接不出现在列表");
  if (fileLinks) {
    ok(!names.includes("leak.md"), "库外文件符号链接不出现在列表");
    const linked = rootList.find((e) => e.name === "linked-note.md");
    ok(linked && !linked.isDir, "库内文件符号链接保留（isDir 按目标算）");
  }

  console.log("\n[3] 读文本");
  const hello = (await j("/__fs/text?p=hello.md")).body;
  ok(hello.content.includes("你好") && hello.encoding === "utf-8", "utf-8 读取");
  const gbk = (await j("/__fs/text?p=gbk.txt")).body;
  ok(gbk.content === "中文", `gbk 嗅探解码（得到 ${JSON.stringify(gbk.content)} / ${gbk.encoding}）`);
  const u16 = (await j("/__fs/text?p=u16.txt")).body;
  ok(u16.content === "记事本" && u16.encoding === "utf-16le", `UTF-16LE 解码（${JSON.stringify(u16.content)} / ${u16.encoding}）`);
  const bom = (await j("/__fs/text?p=bom.md")).body;
  ok(bom.content.startsWith("# 标题"), `UTF-8 BOM 剥离（得到 ${JSON.stringify(bom.content.slice(0, 4))}）`);
  const bin = (await j("/__fs/text?p=bin.dat")).body;
  ok(bin.encoding === "binary", "二进制识别");
  const trunc = (await j("/__fs/text?p=big.txt&max=100")).body;
  ok(trunc.truncated && trunc.content.length === 100 && trunc.size === 1000, "截断语义");

  console.log("\n[4] raw 流");
  const raw = await fetch(`${BASE}/__fs/raw/docs/report.html`);
  ok(
    raw.status === 200 && (raw.headers.get("content-type") || "").includes("text/html"),
    "html content-type",
  );
  ok((await raw.text()).includes("report"), "raw 内容");

  console.log("\n[5] 搜索");
  await j("/__fs/reindex", { method: "POST" });
  await new Promise((r) => setTimeout(r, 800));
  const hits = (await j("/__fs/search?q=report")).body;
  ok(
    Array.isArray(hits) && hits.some((h) => h.rel === "docs/report.html"),
    "文件名搜索命中",
  );
  const noGit = (await j("/__fs/search?q=secret")).body;
  ok(!noGit.some((h) => h.rel.startsWith(".git/")), "搜索不含 .git");
  ok(
    !noGit.some((h) => h.rel.startsWith("escape-link/")),
    "目录符号链接不被跟随（库外内容不入索引）",
  );
  if (fileLinks) {
    const linkHits = (await j("/__fs/search?q=linked-note")).body;
    ok(
      linkHits.some((h) => h.rel === "linked-note.md"),
      "库内文件符号链接可被搜索到",
    );
    const leakHits = (await j("/__fs/search?q=leak")).body;
    ok(!leakHits.some((h) => h.rel === "leak.md"), "库外文件符号链接不入索引");
  }
  // F6：删除后应从索引消失（重建后）
  fs.unlinkSync(path.join(lib, "docs/data.txt"));
  await j("/__fs/reindex", { method: "POST" });
  await new Promise((r) => setTimeout(r, 800));
  const afterDel = (await j("/__fs/search?q=data")).body;
  ok(!afterDel.some((h) => h.rel === "docs/data.txt"), "删除的文件从索引移除");

  console.log("\n[6] 攻击面");
  ok((await j("/__fs/text?p=../outside.txt")).status >= 400, "拒绝 ..");
  ok((await j("/__fs/text?p=%2e%2e/etc/passwd")).status >= 400, "拒绝编码后的 ..");
  ok((await j(`/__fs/text?p=${encodeURIComponent("/etc/passwd")}`)).status >= 400, "拒绝绝对路径");
  const esc = await j("/__fs/text?p=escape-link/secret.txt");
  ok(esc.status >= 400, "拒绝符号链接逃逸", `(got ${esc.status})`);
  {
    // 我们发 "sandbox; default-src 'none'; style-src 'unsafe-inline'"：裸 sandbox = 不跑脚本、opaque origin。
    // 底线是 sandbox 不带 allow-same-origin（带了文档就拿到 dev origin）。本机的过滤代理（如 AdGuard）会把 sandbox 改成
    // "sandbox allow-scripts"（它的源 local.adguard.org 随之出现）——只有认出这种改写时才放过追加的标志，否则要求裸 sandbox
    const header = raw.headers.get("content-security-policy");
    const csp = cspDirectives(header);
    const sandbox = csp.get("sandbox");
    const rewritten = /(^|[\s;])local\.adguard\.org([\s;]|$)/.test(header ?? "");
    if (rewritten) console.log(`  · 原始文档 CSP 被本机 AdGuard 改写，只断言它改不掉的部分：${header}`);
    ok(!!sandbox && !sandbox.includes("allow-same-origin") && (rewritten || sandbox.length === 0)
      && csp.has("default-src") && csp.has("style-src")
      && raw.headers.get("x-content-type-options") === "nosniff", "原始文档不获得 dev origin 脚本权限", header);
  }
  const rawEsc = await fetch(`${BASE}/__fs/raw/escape-link/secret.txt`);
  ok(rawEsc.status >= 400, "raw 拒绝符号链接逃逸", `(got ${rawEsc.status})`);
  const rawDot = await fetch(`${BASE}/__fs/raw/..%2f..%2fetc%2fpasswd`);
  ok(rawDot.status >= 400, "raw 拒绝 ..", `(got ${rawDot.status})`);
  // 写路径穿符号链接建目录：必须拒绝，且库外零副作用（修复前会先 mkdir 再验证）
  const wEsc = await j("/__fs/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "escape-link/a/pwn.md", content: "x" }),
  });
  ok(wEsc.status >= 400, "写拒绝穿符号链接", `(got ${wEsc.status})`);
  ok(!fs.existsSync(path.join(outside, "a")), "库外不产生目录副作用");
  // 库内建缺失父目录：合法路径要能写成
  const wNest = await j("/__fs/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: ".openfile/notes/e2e.md", content: "任务" }),
  });
  ok(wNest.status === 200, "写自动创建库内父目录", `(got ${wNest.status})`);
  ok(
    fs.readFileSync(path.join(lib, ".openfile/notes/e2e.md"), "utf-8") === "任务",
    "嵌套写内容正确",
  );

  if (WIN) {
    console.log("\n[6b] Windows 路径形态：反斜杠穿越 / 盘符相对 / 备用数据流 / 设备名 / 尾点");
    // 每种形态都指向真实目标：放过任何一个，要么读写到库外，要么给已有文件起了绕过名字检查的别名
    const outBase = path.basename(outside);
    const tag = `openfile-e2e-win-${process.pid}`;
    const drive = path.parse(lib).root.slice(0, 2); // 文库所在盘，如 "C:"
    const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort().join("|");
    const before = tree(lib) + "#" + tree(outside);
    const strayTargets = [
      path.win32.resolve(lib, `..\\..\\${tag}`), path.win32.resolve(lib, `..\\..\\${tag}.md`),
      path.resolve(`${drive}${tag}`), path.resolve(`${drive}${tag}.md`), // 本进程该盘的当前目录（vite 继承同一环境）
    ];
    const reads = [
      `..\\..\\${tag}`, `..\\${outBase}\\secret.txt`, `docs\\..\\..\\${outBase}\\secret.txt`,
      `${drive}${tag}`, `${drive}..\\${outBase}\\secret.txt`,
      "hello.md::$DATA", `${tag}::$DATA`, "CON", "docs\\CON", "hello.md.", "a.md.",
    ];
    // 4xx 且不回库外内容；超时（例如真去读了 CON 设备）记 -1
    const probe = async (url, init) => {
      try {
        if (url.startsWith("/__fs/raw/")) {
          const r = await fetch(BASE + url, { ...init, signal: AbortSignal.timeout(10_000) });
          return { status: r.status, body: await r.text() };
        }
        const [method, params] = fsCall(url, init);
        const r = await rpc(method, params, RPC_HEADERS, AbortSignal.timeout(10_000));
        return { status: r.status, body: JSON.stringify(r.body) };
      } catch (e) {
        return { status: -1, body: String(e) };
      }
    };
    const rejected = (r) => r.status >= 400 && r.status < 500 && !r.body.includes("OUTSIDE");
    for (const [label, url] of [
      ["text", (p) => `/__fs/text?p=${encodeURIComponent(p)}`],
      ["raw", (p) => `/__fs/raw/${encodeURIComponent(p)}`],
      ["bin", (p) => `/__fs/bin?p=${encodeURIComponent(p)}`],
      ["stat", (p) => `/__fs/stat?p=${encodeURIComponent(p)}`],
      ["list", (p) => `/__fs/list?p=${encodeURIComponent(p)}`],
    ]) {
      const leaks = [];
      for (const p of reads) {
        const r = await probe(url(p));
        if (!rejected(r)) leaks.push(`${JSON.stringify(p)} → ${r.status}`);
      }
      ok(leaks.length === 0, `${label} 拒绝 Windows 路径形态（4xx）`, leaks.join("; "));
    }
    const writes = [
      `..\\..\\${tag}.md`, `..\\${outBase}\\${tag}.md`, `docs\\..\\..\\${outBase}\\${tag}-nested.md`,
      `${drive}${tag}.md`, `${drive}..\\${outBase}\\${tag}-drive.md`,
      `${tag}.md::$DATA`, `hello.md:${tag}`, "CON", "docs\\CON", `${tag}.md.`, `${tag}.md `,
    ];
    const accepted = [];
    for (const p of writes) {
      const r = await probe("/__fs/write", {
        method: "POST",
        headers: { "content-type": "application/json", "x-openfile-request": "1" },
        body: JSON.stringify({ path: p, content: "pwned" }),
      });
      if (!rejected(r)) accepted.push(`${JSON.stringify(p)} → ${r.status}`);
    }
    ok(accepted.length === 0, "写入拒绝 Windows 路径形态（4xx）", accepted.join("; "));
    ok(before === tree(lib) + "#" + tree(outside), "以上 Windows 形态攻击：文库与库外零副作用");
    const strays = strayTargets.filter((p) => fs.existsSync(p));
    ok(strays.length === 0, "穿越 / 盘符相对目标处没有落下文件", strays.join("; "));
    ok(fs.readFileSync(path.join(lib, "hello.md"), "utf8").includes("你好"), "备用数据流写入没有改动已有文档");
  }

  console.log("\n[7] 变更 SSE");
  const gotChange = await new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
      resolve(false);
    }, 6000);
    fetch(`${BASE}/__rpc/events`, { signal: ac.signal })
      .then(async (r) => {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        setTimeout(
          () => fs.writeFileSync(path.join(lib, "docs/new-note.md"), "# new"),
          400,
        );
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          if (buf.includes("docs/new-note.md")) {
            clearTimeout(timer);
            ac.abort();
            resolve(true);
            return;
          }
        }
        resolve(false);
      })
      .catch(() => resolve(false));
  });
  ok(gotChange, "文件新增在 6s 内推送到 SSE");

  console.log("\n[8] 切库竞态（旧库索引未完时切新库）");
  {
    // 大库 A：2000 个文件拖慢索引；随后立刻切到小库 B——B 的索引必须最终建出来
    const libA = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-race-a-"));
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(libA, `f${i}.txt`), "x");
    const libB = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-race-b-"));
    fs.writeFileSync(path.join(libB, "only.md"), "# b");
    await j("/__fs/library", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: libA }),
    });
    // 不等待，立刻切 B
    await j("/__fs/library", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: libB }),
    });
    let finalCount = null;
    for (let t = 0; t < 30; t++) {
      const c = (await j("/__fs/indexcount")).body?.count;
      if (c === 1) {
        finalCount = c;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    ok(finalCount === 1, `新库索引最终建成（count=${finalCount}，期望 1）`);
    const recents = (await j("/__fs/recents")).body;
    ok(Array.isArray(recents) && recents[0]?.root.includes("race-b"), "最近文库记录最新在前");
  }

  console.log("\n[9] 版本层（影子 git）");
  {
    const vlib = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-ver-"));
    fs.writeFileSync(path.join(vlib, "ch1.md"), "# 第一章\n\n初稿正文。\n");
    fs.mkdirSync(path.join(vlib, ".git")); // 用户自己的仓库标记，必须不受影响
    fs.writeFileSync(path.join(vlib, ".git", "marker"), "user-git");
    fs.mkdirSync(path.join(vlib, ".openfile/notes"), { recursive: true });
    fs.writeFileSync(path.join(vlib, ".openfile/notes/privacy.md"), "# 普通笔记\n");
    fs.writeFileSync(path.join(vlib, ".openfile/settings.json"), "SYNTHETIC_CONFIG_OLD");
    fs.writeFileSync(path.join(vlib, ".env"), "SYNTHETIC_ENV_OLD");
    await j("/__fs/library", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: vlib }),
    });
    const snapJson = (label) =>
      j("/__fs/ver/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
    const s1 = (await snapJson("初稿")).body;
    ok(s1 && s1.label === "初稿", "首次快照成功");
    const firstFiles = (await j(`/__fs/ver/changes?id=${s1.id}`)).body.map((c) => c.path);
    ok(!firstFiles.includes(".env") && !firstFiles.includes(".openfile/settings.json") && firstFiles.includes(".openfile/notes/privacy.md"), "快照排除凭据和本机配置，保留 .openfile 下的普通文档");
    fs.writeFileSync(path.join(vlib, ".openfile/settings.json"), "SYNTHETIC_CONFIG_CURRENT");
    fs.writeFileSync(path.join(vlib, ".env"), "SYNTHETIC_ENV_CURRENT");
    const sNone = (await snapJson("无变化")).body;
    ok(sNone === null, "无变化不产生快照");
    fs.writeFileSync(path.join(vlib, "ch1.md"), "# 第一章\n\n第二稿，改写了这句。\n");
    fs.writeFileSync(path.join(vlib, "ch2.md"), "# 第二章\n\n新增章节。\n");
    const s2 = (await snapJson("第二稿")).body;
    ok(s2 && s2.filesChanged === 2, `第二次快照统计（files=${s2?.filesChanged}）`);
    const list = (await j("/__fs/ver/list")).body;
    ok(list.length === 2 && list[0].label === "第二稿", "时间线列表新→旧");
    const changes = (await j(`/__fs/ver/changes?id=${s2.id}`)).body;
    ok(
      changes.some((c) => c.path === "ch1.md" && c.status === "modified") &&
        changes.some((c) => c.path === "ch2.md" && c.status === "added"),
      "变更清单状态正确",
    );
    // from：跨过中间快照比（会话一轮的「轮前 → 轮后」）
    fs.writeFileSync(path.join(vlib, "ch3.md"), "# 第三章\n");
    const s3 = (await snapJson("第三章")).body;
    const span = (await j(`/__fs/ver/changes?id=${s3.id}&from=${s1.id}`)).body.map((c) => `${c.status}:${c.path}`).sort();
    ok(span.includes("modified:ch1.md") && span.includes("added:ch2.md") && span.includes("added:ch3.md"), "changes?from= 包含中间快照的改动", JSON.stringify(span));
    ok((await j(`/__fs/ver/changes?id=${s3.id}&from=..`)).status === 400, "changes?from= 拒绝非法 id");
    const pair = (await j(`/__fs/ver/file?path=ch1.md&from=${s1.id}&to=${s2.id}`)).body;
    ok(pair.old.includes("初稿") && pair.new.includes("第二稿"), "版本间文件对比");
    const pairWork = (await j(`/__fs/ver/file?path=ch1.md&from=${s1.id}`)).body;
    ok(pairWork.new.includes("第二稿"), "对比工作区");
    // ver/bin：快照里的原始字节（docx 的轮前基线）
    const binOld = (await j(`/__fs/ver/bin?id=${s1.id}&path=ch1.md`)).body;
    ok(binOld && Buffer.from(binOld.b64, "base64").toString("utf8").includes("初稿") && binOld.size > 0, "ver/bin 读出快照里的原字节");
    ok((await j(`/__fs/ver/bin?id=${s1.id}&path=ch2.md`)).body === null, "ver/bin 该版本没有的文件给 null");
    ok((await j("/__fs/ver/bin?id=..&path=ch1.md")).status === 400, "ver/bin 拒绝非法快照 id");
    // 制造未快照的脏改动——还原必须先用安全快照兜住它
    fs.writeFileSync(path.join(vlib, "ch1.md"), "# 第一章\n\n未快照的第三稿改动。\n");
    // 还原单文件
    await j("/__fs/ver/restorefile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: s1.id, path: "ch1.md" }),
    });
    ok(
      fs.readFileSync(path.join(vlib, "ch1.md"), "utf-8").includes("初稿"),
      "单文件还原生效",
    );
    const list2 = (await j("/__fs/ver/list")).body;
    ok(list2.some((s) => s.label.includes("还原前")), "还原前自动打了安全快照");
    // 整库还原到 s2：精确状态
    await j("/__fs/ver/restoresnap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: s2.id }),
    });
    ok(
      fs.readFileSync(path.join(vlib, "ch1.md"), "utf-8").includes("第二稿") &&
        fs.existsSync(path.join(vlib, "ch2.md")),
      "整库还原到目标快照",
    );
    ok(
      fs.readFileSync(path.join(vlib, ".git", "marker"), "utf-8") === "user-git" &&
        !fs.existsSync(path.join(vlib, ".openfile-shadow")),
      "用户 .git 完好，文库内零影子痕迹",
    );
    // 攻击面：restorefile 越权
    const atk = await j("/__fs/ver/restorefile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: s1.id, path: "../evil.md" }),
    });
    ok(atk.status >= 400, "还原接口拒绝越权路径");
    const secretRestore = await j("/__fs/ver/restorefile", { method: "POST", body: JSON.stringify({ id: s1.id, path: ".env" }) });
    ok(secretRestore.status >= 400 && JSON.stringify(secretRestore.body).includes("凭据不能"), "单文件还原明确拒绝凭据");
    ok(fs.readFileSync(path.join(vlib, ".env"), "utf8") === "SYNTHETIC_ENV_CURRENT" && fs.readFileSync(path.join(vlib, ".openfile/settings.json"), "utf8") === "SYNTHETIC_CONFIG_CURRENT", "整库与单文件还原不覆盖当前认证状态");
  }

  console.log("\n[10] 写入（审阅落盘）");
  {
    const wlib = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-write-"));
    fs.mkdirSync(path.join(wlib, "docs"));
    await j("/__fs/library", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: wlib }),
    });
    const w = (p, content) =>
      j("/__fs/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: p, content }),
      });
    const r1 = await w("docs/note.md", "他推开门{++，带着潮气++}。");
    ok(r1.status === 200, "库内写入成功");
    ok(
      fs.readFileSync(path.join(wlib, "docs/note.md"), "utf-8").includes("潮气"),
      "内容落盘",
    );
    ok((await w("../evil.md", "x")).status >= 400, "写入拒绝 ..");
    ok((await w("/etc/evil", "x")).status >= 400, "写入拒绝绝对路径");
    const st = await j("/__fs/stat?p=docs/note.md");
    ok(st.status === 200 && st.body.size > 0 && !st.body.isDir, "stat 端点");
    const leftovers = fs
      .readdirSync(path.join(wlib, "docs"))
      .filter((n) => n.startsWith(".openfile-tmp"));
    ok(leftovers.length === 0, "原子写无临时文件残留");
  }

  console.log("[fileop] 文件管理：攻击用例先行");
  {
    const flib = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-fileop-")));
    const fout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openfile-e2e-fileop-out-")));
    fs.mkdirSync(path.join(flib, "docs/sub"), { recursive: true });
    fs.mkdirSync(path.join(flib, ".openfile/notes"), { recursive: true });
    fs.writeFileSync(path.join(flib, ".openfile/notes/t.md"), "task");
    fs.writeFileSync(path.join(flib, "docs/a.md"), "A");
    fs.writeFileSync(path.join(flib, "docs/sub/b.md"), "B");
    fs.writeFileSync(path.join(fout, "secret.txt"), "S");
    // Windows 形态只对这两个可抛弃的条目下手：放过一个也不会连带打坏后面依赖 docs/ 的断言
    if (WIN) {
      fs.writeFileSync(path.join(flib, "w.md"), "W");
      fs.mkdirSync(path.join(flib, "wdir"));
    }
    // 目录链接无特权也建得出（Windows 退回 junction），逃逸断言永远跑；文件链接建不了时只跳过叶子链接那组
    linkDir(fout, path.join(flib, "escape"));
    const fileLinks =
      linkFile(path.join(flib, "docs/a.md"), path.join(flib, "AGENTS.md")) &&
      linkFile(path.join(fout, "secret.txt"), path.join(flib, "leak"));
    await j("/__fs/library", { method: "POST", body: JSON.stringify({ path: flib }) });
    const op = (body) => j("/__fs/fileop", { method: "POST", body: JSON.stringify(body) });
    const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort().join("|");
    const before = tree(flib) + "#" + tree(fout);

    const bads = ["../x", "docs/../../x", path.join(fout, "secret.txt"), "docs/a\u0000.md"];
    let rejected = true;
    for (const bad of bads) {
      for (const body of [
        { op: "rename", rel: bad, name: "x" }, { op: "move", rel: bad, dir: "docs" }, { op: "copy", rel: bad, dir: "docs" },
        { op: "trash", rel: bad }, { op: "info", rel: bad }, { op: "move", rel: "docs/a.md", dir: bad },
        { op: "copy", rel: "docs/a.md", dir: bad }, { op: "mkdir", dir: bad, name: "n" },
      ]) if ((await op(body)).status < 400) { rejected = false; console.error("    未拒绝:", JSON.stringify(body)); }
    }
    ok(rejected, "越界 / 绝对路径 / NUL：源与目标两侧全部拒绝");
    let badNames = true;
    for (const name of ["", ".", "..", "a/b", "a\\b", "../x", " x", ".openfile", ".git"]) {
      if ((await op({ op: "rename", rel: "docs/a.md", name })).status < 400) badNames = false;
      if ((await op({ op: "mkdir", dir: "docs", name })).status < 400) badNames = false;
    }
    ok(badNames, "非法名称全部拒绝");
    ok((await op({ op: "trash", rel: "" })).status >= 400 && (await op({ op: "rename", rel: ".", name: "x" })).status >= 400, "文库根不可操作");
    ok((await op({ op: "trash", rel: ".openfile" })).status >= 400
      && (await op({ op: "rename", rel: ".openfile/notes/t.md", name: "y.md" })).status >= 400
      && (await op({ op: "move", rel: "docs/a.md", dir: ".openfile/notes" })).status >= 400
      && (await op({ op: "copy", rel: ".openfile/notes/t.md", dir: "docs" })).status >= 400, "内部目录 .openfile 不在此处管理");
    ok((await op({ op: "move", rel: "docs", dir: "docs/sub" })).status >= 400 && (await op({ op: "copy", rel: "docs", dir: "docs/sub" })).status >= 400, "目录不能放进它自己");
    ok((await op({ op: "rename", rel: "docs/a.md", name: "x", expectedRoot: flib + "-other" })).status === 409, "旧文库的文件操作被拒");
    ok((await op({ op: "rename", rel: "escape/secret.txt", name: "x.txt" })).status >= 400
      && (await op({ op: "trash", rel: "escape/secret.txt" })).status >= 400
      && (await op({ op: "info", rel: "escape/secret.txt" })).status >= 400
      && (await op({ op: "move", rel: "docs/a.md", dir: "escape" })).status >= 400
      && (await op({ op: "copy", rel: "docs/a.md", dir: "escape" })).status >= 400
      && (await op({ op: "mkdir", dir: "escape", name: "n" })).status >= 400, "穿符号链接逃逸：源与目标两侧拒绝");
    let strays = [];
    if (WIN) {
      // 源：已有条目的别名（备用数据流 / 尾点 / 尾空格）、设备名、反斜杠穿越、盘符相对；目标与新名字同理
      const tag = `openfile-e2e-fileop-${process.pid}`;
      const drive = path.parse(flib).root.slice(0, 2);
      const escapes = [`..\\..\\${tag}`, `wdir\\..\\..\\${tag}`, `${drive}${tag}`, `${drive}..\\${path.basename(fout)}`];
      const sources = ["w.md::$DATA", "w.md:stream", "w.md.", "w.md ", "wdir.", "wdir ", "wdir::$INDEX_ALLOCATION", "CON", "wdir/CON", ...escapes];
      const dirs = ["wdir.", "wdir::$INDEX_ALLOCATION", "CON", "wdir/CON", ...escapes];
      const names = ["CON", "con.md", "w2.md.", "w2.md ", "x::$DATA", "w.md:stream", `${drive}x`, `..\\..\\${tag}`];
      const accepted = [];
      let n = 0;
      // 放过一个就记下并补回可抛弃条目，后面的形态照样在完好的现场上判（副作用仍由下面的零副作用断言兜住）
      const expectReject = async (body) => {
        const { status } = await op(body);
        if (status < 400 || status >= 500) {
          accepted.push(`${JSON.stringify(body)} → ${status}`);
          if (!fs.existsSync(path.join(flib, "w.md"))) fs.writeFileSync(path.join(flib, "w.md"), "W");
          if (!fs.existsSync(path.join(flib, "wdir"))) fs.mkdirSync(path.join(flib, "wdir"));
        }
      };
      for (const dir of dirs) {
        for (const body of [{ op: "move", rel: "w.md", dir }, { op: "copy", rel: "w.md", dir }, { op: "mkdir", dir, name: "n" }]) await expectReject(body);
      }
      for (const name of names) {
        await expectReject({ op: "rename", rel: "w.md", name });
        await expectReject({ op: "mkdir", dir: "wdir", name });
      }
      for (const rel of sources) {
        for (const body of [{ op: "info", rel }, { op: "copy", rel, dir: "wdir" }, { op: "rename", rel, name: `renamed-${++n}` },
          { op: "move", rel, dir: "wdir" }, { op: "trash", rel }]) await expectReject(body);
      }
      ok(accepted.length === 0, "Windows 路径形态（备用数据流 / 尾点尾空格 / 设备名 / 反斜杠穿越 / 盘符相对）：源、目标、新名字全部拒绝", accepted.join(" "));
      strays = [`..\\..\\${tag}`, `wdir\\..\\..\\${tag}`].map((p) => path.win32.resolve(flib, p))
        .concat(path.resolve(`${drive}${tag}`)).filter((p) => fs.existsSync(p));
    }
    ok(before === tree(flib) + "#" + tree(fout), "以上攻击零副作用");
    if (WIN) ok(strays.length === 0, "Windows 形态穿越目标处没有落下文件", strays.join("; "));

    if (fileLinks) {
      ok((await op({ op: "copy", rel: "leak", dir: "docs" })).status >= 400, "不复制符号链接");
      const info = await op({ op: "info", rel: "leak" });
      ok(info.status === 200 && info.body.isSymlink && !info.body.isDir, "属性不解引用叶子链接");
      ok((await op({ op: "trash", rel: "AGENTS.md" })).status === 200 && fs.existsSync(path.join(flib, "docs/a.md")) && !fs.existsSync(path.join(flib, "AGENTS.md")), "丢的是链接本身，目标原地不动");
      ok((await op({ op: "rename", rel: "leak", name: "leak2" })).body?.rel === "leak2" && fs.lstatSync(path.join(flib, "leak2")).isSymbolicLink() && fs.readFileSync(path.join(fout, "secret.txt"), "utf8") === "S", "改名改的是链接，库外目标不动");
    }
    // 树内目录链接：下面的目录递归复制必须跳过它
    linkDir(fout, path.join(flib, "docs/sub/out"));
    fs.writeFileSync(path.join(flib, "docs/sub/a.md"), "OTHER");
    ok((await op({ op: "move", rel: "docs/a.md", dir: "docs/sub" })).status === 409
      && (await op({ op: "rename", rel: "docs/a.md", name: "sub" })).status === 409
      && (await op({ op: "mkdir", dir: "docs", name: "sub" })).status === 409
      && fs.readFileSync(path.join(flib, "docs/sub/a.md"), "utf8") === "OTHER", "永不覆盖");
    ok((await op({ op: "copy", rel: "docs/a.md", dir: "docs/sub" })).body?.rel === "docs/sub/a 副本.md"
      && (await op({ op: "copy", rel: "docs/a.md", dir: "docs/sub" })).body?.rel === "docs/sub/a 副本 2.md", "复制撞名走副本序列");
    const dirCopy = await op({ op: "copy", rel: "docs", dir: "" });
    ok(dirCopy.body?.rel === "docs 副本" && fs.readFileSync(path.join(flib, "docs 副本/sub/b.md"), "utf8") === "B" && !fs.existsSync(path.join(flib, "docs 副本/sub/out")), "目录递归复制，树内符号链接跳过");
    ok((await op({ op: "mkdir", dir: "", name: "新建" })).body?.rel === "新建"
      && (await op({ op: "move", rel: "docs/a.md", dir: "新建" })).body?.rel === "新建/a.md"
      && (await op({ op: "rename", rel: "新建/a.md", name: "甲.md" })).body?.rel === "新建/甲.md"
      && fs.readFileSync(path.join(flib, "新建/甲.md"), "utf8") === "A", "新建 / 移动 / 重命名");
    const dinfo = await op({ op: "info", rel: "docs 副本" });
    ok(dinfo.status === 200 && dinfo.body.isDir && dinfo.body.items === 6 && dinfo.body.size === 9, "目录属性递归合计", JSON.stringify(dinfo.body));
    ok((await op({ op: "trash", rel: "新建/甲.md" })).status === 200 && !fs.existsSync(path.join(flib, "新建/甲.md")) && fs.readFileSync(path.join(TRASH_DIR, "甲.md"), "utf8") === "A", "移到废纸篓（不是硬删）");
  }

  console.log("[proc] 拉起进程：护栏");
  {
    const noHdrSpawn = await rpc("proc.spawnAgent", { pid: "csrf", cmd: process.execPath, args: ["-e", "1"] }, { "content-type": "application/json" });
    ok(noHdrSpawn.status === 403, "拉起进程要显式请求头（CSRF 挡板）", String(noHdrSpawn.status));
    ok((await rpc("no.such.method")).status === 404, "未知方法 → 404");
    ok((await rpc("internal.snapshotFolder", { root: lib })).status === 404, "宿主专用方法（internal.*）浏览器调不到 → 404");
  }

  console.log(`\n结果：${failures === 0 ? "全部通过 ✓" : `${failures} 项失败 ✗`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    stopVite();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
