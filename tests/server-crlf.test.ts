// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const onlyCrlf = (s: string) => !s.replace(/\r\n/g, "").includes("\n");

describe("MCP server：CRLF 文档（真实 server，合成临时文库）", () => {
  const client = new Client({ name: "crlf-test", version: "0" });
  let root: string;
  let bundleDir: string;
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { err: !!r.isError, text: JSON.stringify(r.content) };
  };
  beforeAll(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "of-mcp-crlf-")));
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs/win.md"), "# 标题\r\n\r\n第一行\r\n第二行\r\n\r\n尾段。\r\n");
    fs.writeFileSync(path.join(root, "docs/lf.md"), "# LF\n\n甲\n乙\n");
    // 自己打一份独立的包（同 scripts/openfile-mcp.mjs 的配方）：启动器的固定缓存文件在并行测试里会被别的进程同时改写
    const cache = path.resolve("node_modules/.cache");
    fs.mkdirSync(cache, { recursive: true });
    bundleDir = fs.mkdtempSync(path.join(cache, "openfile-mcp-crlf-"));
    const outfile = path.join(bundleDir, "server.mjs");
    await build({
      entryPoints: [path.resolve("packages/runtime/src/mcp/server.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      logLevel: "warning",
      define: { __OPENFILE_VERSION__: JSON.stringify("0.0.0-test") },
      banner: { js: "import { createRequire as __ofCreateRequire } from 'node:module'; const require = __ofCreateRequire(import.meta.url);" },
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [outfile, "--root", root, "--tools", "all"],
      env: { ...process.env, OPENFILE_APPDATA: path.join(root, ".appdata") } as Record<string, string>,
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 60_000);
  afterAll(async () => {
    await client.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (bundleDir) fs.rmSync(bundleDir, { recursive: true, force: true });
  });

  it("suggest_edit：LF 多行锚点对得上 CRLF 文档，标记里的换行随文档", async () => {
    const r = await call("suggest_edit", { path: "docs/win.md", old_text: "第一行\n第二行", new_text: "合并成一句", author: "claude" });
    expect(r.err, r.text).toBe(false);
    const doc = read("docs/win.md");
    expect(doc).toContain("\r\n\r\n{~~@claude: 第一行\r\n第二行~>合并成一句~~}\r\n\r\n尾段。");
    expect(onlyCrlf(doc)).toBe(true);
  });

  it("suggest_edit：新文本里的换行写成 CRLF", async () => {
    const r = await call("suggest_edit", { path: "docs/win.md", old_text: "尾段。", new_text: "尾段。\n补一行。", author: "claude", note: "解释\n两行" });
    expect(r.err, r.text).toBe(false);
    const doc = read("docs/win.md");
    expect(doc).toContain("尾段。{++@claude: \r\n补一行。++}{>>@claude: 解释\r\n两行<<}");
    expect(onlyCrlf(doc)).toBe(true);
  });

  it("suggest_edit：只差换行风格 = 无事可做", async () => {
    const r = await call("suggest_edit", { path: "docs/lf.md", old_text: "甲\n乙", new_text: "甲\r\n乙", author: "claude" });
    expect(r.err).toBe(true);
    expect(read("docs/lf.md")).toBe("# LF\n\n甲\n乙\n");
  });

  it("add_comment：LF 多行锚点 + 多行批注，CRLF 不被打散", async () => {
    fs.writeFileSync(path.join(root, "docs/c.md"), "甲\r\n乙\r\n丙\r\n");
    const r = await call("add_comment", { path: "docs/c.md", anchor_text: "甲\n乙", comment: "意见一\n意见二", author: "claude" });
    expect(r.err, r.text).toBe(false);
    expect(read("docs/c.md")).toBe("甲\r\n乙{>>@claude: 意见一\r\n意见二<<}\r\n丙\r\n");
  });

  it("write_doc：覆盖 CRLF 文件沿用 CRLF；新文件与 LF 文件原样 / LF", async () => {
    fs.writeFileSync(path.join(root, "docs/old-crlf.md"), "旧\r\n内容\r\n");
    expect((await call("write_doc", { path: "docs/old-crlf.md", content: "新\n内容\n" })).err).toBe(false);
    expect(read("docs/old-crlf.md")).toBe("新\r\n内容\r\n");
    expect((await call("write_doc", { path: "docs/new.md", content: "新\n文件\n" })).err).toBe(false);
    expect(read("docs/new.md")).toBe("新\n文件\n");
    expect((await call("write_doc", { path: "docs/lf.md", content: "改\r\n写\r\n" })).err).toBe(false);
    expect(read("docs/lf.md")).toBe("改\n写\n");
  });
});
