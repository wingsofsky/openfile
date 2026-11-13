// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killProcessTree, parseCmdShim, resolveSpawnCommand } from "../packages/runtime/src/lib/spawn-command.mjs";

const W = path.win32;
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const NPM_DIR = "C:\\Users\\me\\AppData\\Roaming\\npm";

/** npm cmd-shim（npm 7+ 全局安装的 .cmd 垫片原样） */
const CMD_SHIM = (target) => [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
  "",
].join("\r\n");

/** Node 安装目录自带的 npx.cmd（npm 10/11） */
const NPX_CMD = [
  ":: Created by npm, please don't edit manually.",
  "@ECHO OFF",
  "",
  "SETLOCAL",
  "",
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ")",
  "",
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
  "FOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (",
  '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"',
  ")",
  'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (',
  '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"',
  ")",
  "",
  '"%NODE_EXE%" "%NPX_CLI_JS%" %*',
  "",
].join("\r\n");

/** 老 cmd-shim（npm 6） */
const OLD_SHIM = [
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\old-cli\\bin\\cli.js" %*',
  ") ELSE (",
  "  @SETLOCAL",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  '  node  "%~dp0\\node_modules\\old-cli\\bin\\cli.js" %*',
  ")",
].join("\r\n");

describe("parseCmdShim：npm 的 .cmd 垫片 → JS 入口（不执行批处理）", () => {
  it("cmd-shim 格式", () => {
    expect(parseCmdShim(CMD_SHIM("node_modules\\@google\\gemini-cli\\dist\\index.js"), NPM_DIR)).toEqual({
      kind: "node",
      script: `${NPM_DIR}\\node_modules\\@google\\gemini-cli\\dist\\index.js`,
      args: [],
    });
  });

  it("Node 自带的 npx.cmd：取默认分支的 npx-cli.js", () => {
    expect(parseCmdShim(NPX_CMD, "C:\\Program Files\\nodejs")).toEqual({
      kind: "node",
      script: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
      args: [],
    });
  });

  it("老 cmd-shim（npm 6）", () => {
    expect(parseCmdShim(OLD_SHIM, NPM_DIR)).toEqual({ kind: "node", script: `${NPM_DIR}\\node_modules\\old-cli\\bin\\cli.js`, args: [] });
  });

  it("指向原生 .exe 的垫片", () => {
    expect(parseCmdShim('@"%~dp0\\node_modules\\esbuild\\esbuild.exe"   %*\r\n', NPM_DIR)).toEqual({
      kind: "exe",
      file: `${NPM_DIR}\\node_modules\\esbuild\\esbuild.exe`,
      args: [],
    });
  });

  it("看不懂的不猜：没有 %* 行、变量展不开、sh 脚本目标", () => {
    expect(parseCmdShim("@echo hello\r\n", NPM_DIR)).toBeNull();
    expect(parseCmdShim('"%MYSTERY%" %*\r\n', NPM_DIR)).toBeNull();
    expect(parseCmdShim('SET "_prog=bash"\r\n"%_prog%" "%~dp0\\tool.sh" %*\r\n', NPM_DIR)).toBeNull();
  });
});

describe("resolveSpawnCommand：Windows 上不经 shell 也能起 npx / .cmd 垫片", () => {
  const files = new Map();
  const fake = (env) => ({
    platform: "win32",
    env,
    execPath: NODE,
    isFile: (p) => files.has(W.normalize(p).toLowerCase()),
    readFile: (p) => {
      const v = files.get(W.normalize(p).toLowerCase());
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
  });
  const put = (p, content = "") => files.set(W.normalize(p).toLowerCase(), content);
  put("C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js");
  put(`${NPM_DIR}\\gemini`, "#!/bin/sh\n"); // npm 给 Git Bash 用的无后缀垫片：绝不能当可执行文件
  put(`${NPM_DIR}\\gemini.cmd`, CMD_SHIM("node_modules\\@google\\gemini-cli\\dist\\index.js"));
  put(`${NPM_DIR}\\node_modules\\@google\\gemini-cli\\dist\\index.js`);
  put("C:\\tools\\agy-acp-server.exe");
  put("C:\\first\\dup.cmd", CMD_SHIM("node_modules\\dup\\cli.js"));
  put("C:\\first\\node_modules\\dup\\cli.js");
  put("C:\\second\\dup.exe");
  put("C:\\broken\\weird.cmd", "@echo no idea\r\n");
  const env = { Path: `C:\\first;"${NPM_DIR}";C:\\tools;C:\\second;C:\\broken` };

  it("npx：本进程 node 目录里的 npx-cli.js，用 process.execPath 跑", () => {
    expect(resolveSpawnCommand("npx", ["--yes", "@agentclientprotocol/claude-agent-acp"], fake(env))).toEqual({
      file: NODE,
      args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js", "--yes", "@agentclientprotocol/claude-agent-acp"],
    });
  });

  it(".cmd 垫片 → node + JS 入口；无后缀 sh 垫片不算命中；PATH 条目带引号也认", () => {
    expect(resolveSpawnCommand("gemini", ["--acp"], fake(env))).toEqual({
      file: NODE,
      args: [`${NPM_DIR}\\node_modules\\@google\\gemini-cli\\dist\\index.js`, "--acp"],
    });
    expect(resolveSpawnCommand(`${NPM_DIR}\\gemini.cmd`, [], fake(env)).args[0]).toMatch(/index\.js$/);
  });

  it(".exe 给绝对路径；PATH 顺序优先（先命中 .cmd 的目录就用 .cmd）", () => {
    expect(resolveSpawnCommand("agy-acp-server", [], fake(env))).toEqual({ file: "C:\\tools\\agy-acp-server.exe", args: [] });
    expect(resolveSpawnCommand("dup", ["x"], fake(env))).toEqual({ file: NODE, args: ["C:\\first\\node_modules\\dup\\cli.js", "x"] });
  });

  it("找不到 / 看不懂 / 带路径的 .exe：原样交给 spawn（报错走原路径）", () => {
    expect(resolveSpawnCommand("nope", ["a"], fake(env))).toEqual({ file: "nope", args: ["a"] });
    expect(resolveSpawnCommand("weird", [], fake(env))).toEqual({ file: "weird", args: [] });
    expect(resolveSpawnCommand("D:\\x\\agent.exe", ["a"], fake(env))).toEqual({ file: "D:\\x\\agent.exe", args: ["a"] });
    expect(resolveSpawnCommand("/绝不存在/的命令", [], fake(env))).toEqual({ file: "/绝不存在/的命令", args: [] });
  });

  it(".js 入口用 node 跑", () => {
    expect(resolveSpawnCommand("D:\\agents\\x.mjs", ["--stdio"], fake(env))).toEqual({ file: NODE, args: ["D:\\agents\\x.mjs", "--stdio"] });
  });

  it("mac/Linux 原样", () => {
    expect(resolveSpawnCommand("npx", ["--yes", "p"], { ...fake(env), platform: "darwin" })).toEqual({ file: "npx", args: ["--yes", "p"] });
  });

  it.runIf(process.platform === "win32")("真机：解析出的 node 命令行逐字传参，不经 cmd（引号、&、%VAR% 原样）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-shim-"));
    try {
      fs.mkdirSync(path.join(dir, "node_modules", "echo-args"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "echo-args", "cli.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
      fs.writeFileSync(path.join(dir, "echo-args.cmd"), CMD_SHIM("node_modules\\echo-args\\cli.js"));
      const args = ["a b", 'q"uote', "x&y", "%PATH%", "^caret"];
      const t = resolveSpawnCommand("echo-args", args, { env: { PATH: dir } });
      expect(t.file).toBe(process.execPath);
      expect(JSON.parse(execFileSync(t.file, t.args, { encoding: "utf8", windowsHide: true }))).toEqual(args);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
