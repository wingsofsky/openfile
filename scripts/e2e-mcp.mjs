#!/usr/bin/env node
/**
 * MCP server 黑盒 E2E：真实启动器（esbuild 打包 + stdio）× SDK Client ×
 * 临时文库。覆盖：文库读写 / 路径攻击（遍历、绝对路径、NUL、符号链接、
 * 穿链接建目录零副作用）/ CriticMarkup 建议写回与定界符注入拒绝 /
 * 影子快照与 diff（appdata 改道到临时目录）/ 工具分组（--tools）。
 * 退出码非零 = 失败。用法：node scripts/e2e-mcp.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
function ok(cond, name, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const lib = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-mcp-lib-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-mcp-out-"));
const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-mcp-appdata-"));
fs.mkdirSync(path.join(lib, "docs"));
fs.mkdirSync(path.join(lib, ".git"));
fs.writeFileSync(path.join(lib, ".git/secret"), "hidden");
fs.writeFileSync(
  path.join(lib, "hello.md"),
  "# 你好\n\n这是测试文档。【保持术语一致：文库不叫知识库】\n\n重复句。\n\n重复句。\n\n```\n代码里的目标文本\n```\n",
);
fs.writeFileSync(path.join(lib, "docs/report.md"), "# 报告\n\n正文第一段。\n");
fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE");
try {
  fs.symlinkSync(outside, path.join(lib, "escape-link"));
} catch (e) {
  // Windows: unprivileged symlink needs Developer Mode; junction resolves via realpath the same
  if (process.platform === "win32" && e.code === "EPERM")
    fs.symlinkSync(outside, path.join(lib, "escape-link"), "junction");
  else throw e;
}
// 符号链接索引矩阵：库内文件链接（AGENTS.md → CLAUDE.md 场景）应入索引；
// 库外文件链接不入；escape-link（库外目录链接）不被跟随。
// Windows 无开发者模式时建不了文件符号链接（EPERM）：跳过这组断言而不是整套失败
let fileLinks = true;
try {
  fs.symlinkSync(path.join(lib, "hello.md"), path.join(lib, "linked-note.md"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(lib, "leak.md"));
} catch (e) {
  if (process.platform === "win32" && e.code === "EPERM") fileLinks = false;
  else throw e;
}

const client = new Client({ name: "openfile-e2e", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(import.meta.dirname, "openfile-mcp.mjs"), "--root", lib, "--tools", "all"],
  env: { ...process.env, OPENFILE_APPDATA: appdata },
  stderr: "pipe",
});

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content?.[0]?.text ?? "" };
};
const readLib = (rel) => fs.readFileSync(path.join(lib, rel), "utf-8");
/** 与 server 的 canonicalRoot 同口径：Windows 用原生 realpath（展开 8.3 短名——CI 的 TEMP 是 C:\Users\RUNNER~1\…） */
const canonical = (p) => (process.platform === "win32" ? fs.realpathSync.native(p) : fs.realpathSync(p));
/** 删单个文件（不存在也行）。不用 rmSync：Node 24 在 Windows 上对单个文件 rmSync 会直接崩进程（0xC0000409） */
const removeFile = (abs) => {
  try {
    fs.unlinkSync(abs);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
};

try {
  await client.connect(transport);

  console.log("[1] 文库基本面");
  {
    const info = await call("library_info");
    // JSON-escape the expected path: on Windows "\" serializes as "\\" inside the reply text
    const rootNeedle = JSON.stringify(canonical(lib)).slice(1, -1);
    ok(!info.err && info.text.includes(rootNeedle), "library_info 根路径", info.text);
    const ls = await call("list_dir", { path: "" });
    ok(!ls.err && ls.text.includes("hello.md"), "list_dir 列出文件");
    ok(!ls.text.includes(".git"), "list_dir 隐藏 .git");
    // 列目录口径（与 Rust list_dir_at 对齐）：库外符号链接彻底隐藏，库内链接保留
    ok(!ls.text.includes("escape-link"), "list_dir 隐藏库外目录符号链接");
    if (fileLinks) {
      ok(!ls.text.includes("leak.md"), "list_dir 隐藏库外文件符号链接");
      ok(ls.text.includes("linked-note.md"), "list_dir 保留库内文件符号链接");
    }
    const rd = await call("read_doc", { path: "hello.md" });
    ok(!rd.err && rd.text.includes("这是测试文档"), "read_doc 读取");
    const sr = await call("search_files", { query: "report" });
    ok(!sr.err && sr.text.includes("docs/report.md"), "search_files 命中");
    if (fileLinks) {
      const srLink = await call("search_files", { query: "linked-note" });
      ok(!srLink.err && srLink.text.includes("linked-note.md"), "库内文件符号链接可被搜索到");
      const srLeak = await call("search_files", { query: "leak" });
      ok(!srLeak.text.includes("leak.md"), "库外文件符号链接不入索引");
    }
    const srSecret = await call("search_files", { query: "secret" });
    ok(!srSecret.text.includes("escape-link/"), "目录符号链接不被跟随");
    const wr = await call("write_doc", { path: ".openfile/out/产物.md", content: "# 产出\n" });
    ok(!wr.err && readLib(".openfile/out/产物.md") === "# 产出\n", "write_doc 自动建父目录");
    fs.mkdirSync(path.join(lib, "会话/导入"), { recursive: true });
    fs.writeFileSync(path.join(lib, "会话/导入/20260904-0923-abcd-测试会话.md"), "# 会话\n\n用户：我那天说过暗号是蓝鲸。\n\nagent：记住了。\n");
    fs.writeFileSync(path.join(lib, "会话/导入/photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    const st1 = await call("search_text", { query: "蓝鲸" });
    const sj = JSON.parse(st1.text);
    ok(!st1.err && sj.hits.length === 1 && sj.hits[0].path === "会话/导入/20260904-0923-abcd-测试会话.md" && sj.hits[0].line === 3 && sj.hits[0].after[0] === "", "search_text 子串命中 + 行号 + 上下文", st1.text);
    const st2 = await call("search_text", { query: "暗号是(蓝鲸|白鹭)", regex: true, path_prefix: "会话/导入" });
    ok(!st2.err && JSON.parse(st2.text).hits.length === 1, "search_text 正则 + 前缀");
    ok(!JSON.parse((await call("search_text", { query: "蓝鲸", path_prefix: "docs" })).text).hits.length, "前缀过滤生效");
    ok((await call("search_text", { query: "x", path_prefix: "../" })).err, "search_text 前缀出证");
    ok((await call("search_text", { query: "([", regex: true })).err, "坏正则被拒");
  }

  console.log("[2] 攻击面");
  {
    ok((await call("read_doc", { path: "../outside.txt" })).err, "read 拒绝 ..");
    ok((await call("read_doc", { path: "/etc/passwd" })).err, "read 拒绝绝对路径");
    ok((await call("read_doc", { path: "a\0b.md" })).err, "read 拒绝 NUL");
    ok((await call("read_doc", { path: "escape-link/secret.txt" })).err, "read 拒绝符号链接逃逸");
    const w = await call("write_doc", { path: "escape-link/a/pwn.md", content: "x" });
    ok(w.err, "write 拒绝穿符号链接");
    ok(!fs.existsSync(path.join(outside, "a")), "库外零目录副作用");
    ok(
      (await call("suggest_edit", { path: "../x.md", old_text: "a", new_text: "b", author: "claude" })).err,
      "suggest 拒绝越权路径",
    );
  }

  console.log("[3] 审阅建议写回");
  {
    const s1 = await call("suggest_edit", {
      path: "hello.md",
      old_text: "这是测试文档。",
      new_text: "这是被 agent 润色过的测试文档。",
      author: "claude",
      note: "收紧表达",
    });
    ok(!s1.err, "建议写回成功", s1.text);
    const src = readLib("hello.md");
    ok(src.includes("{++@claude: 被 agent 润色过的++}"), "公共前后缀收紧为插入标记");
    ok(src.includes("{>>@claude: 收紧表达<<}"), "附带批注落盘");
    const ann = await call("read_annotations", { path: "hello.md" });
    const parsed = JSON.parse(ann.text);
    ok(parsed.counts.ins === 1 && parsed.counts.comment === 1, "read_annotations 计数", ann.text);
    ok(
      parsed.agent_notes.some((n) => n.text.includes("术语一致")),
      "【给 agent 的话】被提取",
    );
    ok(
      (await call("suggest_edit", { path: "hello.md", old_text: "重复句。", new_text: "x", author: "claude" })).err,
      "非唯一目标拒绝",
    );
    ok(
      (await call("suggest_edit", { path: "hello.md", old_text: "代码里的目标文本", new_text: "x", author: "claude" })).err,
      "代码区内目标拒绝",
    );
    // 真不可表示：newText 含 ~~} 会提前闭合 sub 标记 → 必须拒绝且文件不动
    const inj = await call("suggest_edit", {
      path: "docs/report.md",
      old_text: "正文第一段。",
      new_text: "坏~~}东西",
      author: "claude",
    });
    ok(inj.err, "定界符注入拒绝", inj.text);
    ok(!readLib("docs/report.md").includes("坏"), "注入被拒后文件未动");
    const cm = await call("add_comment", {
      path: "docs/report.md",
      anchor_text: "正文第一段。",
      comment: "这段可以展开",
      author: "gemini",
    });
    ok(!cm.err && readLib("docs/report.md").includes("正文第一段。{>>@gemini: 这段可以展开<<}"), "锚点批注插入");
  }

  console.log("[4] 版本层（影子 git，appdata 已改道）");
  {
    fs.writeFileSync(path.join(lib, "docs/新稿.md"), "# 新稿\n\n第一版。\n");
    const snap = await call("snapshot_now", { label: "e2e 基线" });
    ok(!snap.err, "snapshot_now", snap.text);
    const info = JSON.parse(snap.text);
    ok(typeof info.id === "string" && info.id.length === 10, "快照 id 形态", snap.text);
    const shadows = fs.readdirSync(path.join(appdata, "shadow"));
    ok(shadows.length === 1 && /-[0-9a-f]{16}$/.test(shadows[0]), "影子仓库按 Rust 哈希方案落位", String(shadows));
    fs.writeFileSync(path.join(lib, "docs/report.md"), readLib("docs/report.md") + "\n新增一行。\n");
    const diff = await call("diff_since", { snapshot: info.id });
    ok(!diff.err && diff.text.includes("新增一行"), "diff_since 看到快照之后的改动");
    const dfile = await call("diff_since", { snapshot: info.id, path: "docs/report.md" });
    ok(!dfile.err && dfile.text.includes("report.md"), "按文件 diff");
    ok((await call("diff_since", { snapshot: info.id, path: "../x" })).err, "diff path 出证");
    const list = await call("list_snapshots", {});
    ok(!list.err && JSON.parse(list.text).length >= 1, "时间线含刚打的快照", list.text);
    const changes = await call("snapshot_changes", { id: info.id });
    ok(!changes.err && changes.text.includes("新稿.md"), "快照变更清单", changes.text);
    // 第二个 server 进程发现同一影子（跨进程共享契约）
    const c2 = new Client({ name: "e2e-2", version: "0.0.0" });
    const t2 = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(import.meta.dirname, "openfile-mcp.mjs"), "--root", lib],
      env: { ...process.env, OPENFILE_APPDATA: appdata },
      stderr: "pipe",
    });
    await c2.connect(t2);
    const r2 = await c2.callTool({ name: "list_snapshots", arguments: {} });
    ok(!r2.isError && JSON.parse(r2.content[0].text).length >= 1, "第二进程发现同一影子仓库");
    await c2.close();
  }

  console.log("[5] 工具分组（--tools）");
  {
    const listWith = async (tools) => {
      const c = new Client({ name: "e2e-groups", version: "0.0.0" });
      const t = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(import.meta.dirname, "openfile-mcp.mjs"), "--root", lib, ...(tools ? ["--tools", tools] : [])],
        env: { ...process.env, OPENFILE_APPDATA: appdata },
        stderr: "pipe",
      });
      await c.connect(t);
      const names = (await c.listTools()).tools.map((x) => x.name).sort();
      const prompts = await c.listPrompts().then((r) => r.prompts.map((p) => p.name), () => []);
      const instructions = c.getInstructions() ?? "";
      await c.close();
      return { names, prompts, instructions };
    };
    const def = await listWith(null);
    ok(def.names.length === 13 && def.names.includes("suggest_edit") && def.names.includes("diff_since") && def.prompts.length === 0,
      "不传 --tools：读文件、审阅、快照三组 13 个工具，没有提示词", def.names.join(","));
    const all = await listWith("all");
    ok(all.names.join(",") === def.names.join(","), "--tools all 与默认一致");
    const lean = await listWith("review");
    ok(lean.names.join(",") === "add_comment,read_annotations,suggest_edit", "--tools review 只暴露审阅 3 个工具", lean.names.join(","));
    ok(!lean.instructions.includes("snapshot_now") && lean.instructions.includes("--tools"), "精简登记：说明不提未开分组的工具", lean.instructions.slice(-160));
    const two = await listWith("review,snapshots");
    ok(two.names.length === 7 && two.names.includes("diff_since") && !two.names.includes("read_doc"), "分组可叠加", two.names.join(","));
    const { spawnSync } = await import("node:child_process");
    const bad = spawnSync(process.execPath, [path.join(import.meta.dirname, "openfile-mcp.mjs"), "--root", lib, "--tools", "nope"], { encoding: "utf8", input: "" });
    ok(bad.status === 1 && bad.stderr.includes("--tools"), "不认识的分组直接报错退出", bad.stderr.trim());
  }

} catch (e) {
  failures++;
  console.error(`E2E 异常: ${e?.stack ?? e}`);
} finally {
  await client.close().catch(() => {});
  // maxRetries：Windows 上刚被杀的子进程可能还短暂占着句柄（EBUSY/EPERM）
  for (const dir of [lib, outside, appdata]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures > 0) {
  console.error(`\n结果：${failures} 项失败 ✗`);
  process.exit(1);
}
console.log("\n结果：全部通过 ✓");
