/**
 * 拉起本机程序的平台细节：Windows 的 .cmd 垫片还原、杀进程树。
 * 运行时 API（api/processes.ts）与测试共用这一份。
 */
import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";

const isFileSync = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const JS_EXT = new Set([".js", ".cjs", ".mjs"]);

/** Windows 的 PATH 目录（环境变量名大小写不定；`;` 分隔；条目可能带引号） */
function winPathDirs(env) {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  return raw
    .split(";")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

/**
 * npm 的 .cmd 垫片 → 它实际调用的目标（不执行任何批处理，只做最小的文本解析）。两代格式都认：
 *   cmd-shim：  "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*        （_prog = %dp0%\node.exe 或 node）
 *   npm 自带：  "%NODE_EXE%" "%NPX_CLI_JS%" %*                         （SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"）
 *   旧 cmd-shim：node  "%~dp0\node_modules\pkg\cli.js" %*
 * 变量取文件里的第一次赋值（两种格式的默认分支都在前）。看不懂就返回 null，不猜。
 * @returns {{kind: "node", script: string, args: string[]} | {kind: "exe", file: string, args: string[]} | null}
 */
export function parseCmdShim(text, shimDir) {
  const p = path.win32;
  const dp0 = shimDir.endsWith("\\") ? shimDir : `${shimDir}\\`;
  const vars = new Map([["dp0", dp0]]);
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*@?set\s+"([^"=]+)=([^"]*)"\s*$/i.exec(line) ?? /^\s*@?set\s+([^\s"=]+)=([^"]*?)\s*$/i.exec(line);
    if (m && !vars.has(m[1].toLowerCase())) vars.set(m[1].toLowerCase(), m[2]);
  }
  const expand = (s, depth = 0) =>
    depth > 4
      ? s
      : s
          .replace(/%~dp0/gi, () => dp0)
          .replace(/%([A-Za-z_][\w-]*)%/g, (all, name) => {
            const v = vars.get(name.toLowerCase());
            return v === undefined ? all : expand(v, depth + 1);
          });
  const cmdLine = [...lines].reverse().find((l) => l.includes("%*"));
  if (!cmdLine) return null;
  const tokens = [...cmdLine.matchAll(/"([^"]*)"/g)].map((m) => expand(m[1])).filter((t) => t !== "");
  if (tokens.some((t) => t.includes("%"))) return null; // 还有没展开的变量：不猜
  const norm = (t) => p.normalize(t);
  const base = (t) => p.basename(t).toLowerCase();
  if (tokens.length >= 2 && (base(tokens[0]) === "node.exe" || base(tokens[0]) === "node")) {
    return { kind: "node", script: norm(tokens[1]), args: tokens.slice(2) };
  }
  const js = tokens.findIndex((t) => JS_EXT.has(p.extname(t).toLowerCase()));
  if (js !== -1) return { kind: "node", script: norm(tokens[js]), args: tokens.slice(js + 1) };
  if (tokens.length >= 1 && [".exe", ".com"].includes(p.extname(tokens[0]).toLowerCase())) {
    return { kind: "exe", file: norm(tokens[0]), args: tokens.slice(1) };
  }
  return null;
}

/**
 * agent 命令 → 真正可 spawn 的 {file, args}（不经 shell）。mac/Linux 原样返回。
 * Windows：libuv 只给裸命令名补 .com/.exe，npm 装的 npx / gemini 只有 .cmd 垫片 → ENOENT；直接 spawn .cmd
 * 自 CVE-2024-27980 修复起是 EINVAL；shell: true 又会让自定义命令行的参数经过 cmd 解析。于是：
 *   - npx / npm：本进程 node 目录下的 node_modules\npm\bin\<名>-cli.js，用 process.execPath 跑
 *   - 裸命令名：按 PATH 顺序找 .com/.exe/.bat/.cmd（同 cmd.exe 的查找次序）；.exe 直接给绝对路径
 *   - .cmd/.bat 垫片：解析出 JS 入口（node 跑）或 .exe；看不懂就原样返回，让 spawn 报错
 *   - .js/.cjs/.mjs：node 跑
 */
export function resolveSpawnCommand(cmd, args, { platform = process.platform, env = process.env, execPath = process.execPath, isFile = isFileSync, readFile = (f) => fs.readFileSync(f, "utf8") } = {}) {
  const asIs = { file: cmd, args };
  if (platform !== "win32" || typeof cmd !== "string" || cmd === "") return asIs;
  const p = path.win32;
  const ext = p.extname(cmd).toLowerCase();
  if (JS_EXT.has(ext)) return { file: execPath, args: [cmd, ...args] };
  let shim = null;
  if (/[\\/]/.test(cmd)) {
    if (ext !== ".cmd" && ext !== ".bat") return asIs;
    shim = cmd;
  } else {
    const stem = ext === ".cmd" ? cmd.slice(0, -4).toLowerCase() : cmd.toLowerCase();
    if (stem === "npx" || stem === "npm") {
      const cli = p.join(p.dirname(execPath), "node_modules", "npm", "bin", `${stem}-cli.js`);
      if (isFile(cli)) return { file: execPath, args: [cli, ...args] };
    }
    // 不试无后缀的同名文件：那是 npm 给 Git Bash 用的 sh 垫片
    const exts = ext ? ["", ".com", ".exe", ".bat", ".cmd"] : [".com", ".exe", ".bat", ".cmd"];
    search: for (const dir of winPathDirs(env)) {
      for (const e of exts) {
        const full = p.join(dir, cmd + e);
        if (!isFile(full)) continue;
        const fe = p.extname(full).toLowerCase();
        if (fe === ".cmd" || fe === ".bat") {
          shim = full;
          break search;
        }
        return { file: full, args };
      }
    }
    if (!shim) return asIs;
  }
  let text;
  try {
    text = readFile(shim);
  } catch {
    return asIs;
  }
  const target = parseCmdShim(text, p.dirname(shim));
  if (target?.kind === "node" && isFile(target.script)) return { file: execPath, args: [target.script, ...target.args, ...args] };
  if (target?.kind === "exe" && isFile(target.file)) return { file: target.file, args: [...target.args, ...args] };
  return asIs;
}

/**
 * 杀整棵进程树。Windows 上 proc.kill() 只终止直接子进程——npx-cli → 适配器、cmd → cloudflared 这类孙进程
 * 会成孤儿（libuv 的作业对象允许子进程静默脱离），所以用 taskkill /T /F 顺父 PID 杀全树；其它平台保持 proc.kill()。
 * sync：dev server 关停时用，确保进程退出前树已杀完。
 */
export function killProcessTree(proc, { sync = false, platform = process.platform } = {}) {
  if (!proc) return;
  if (platform === "win32") {
    // 已退出就不动：PID 可能已被系统复用
    if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
    const args = ["/pid", String(proc.pid), "/T", "/F"];
    if (sync) spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    else execFile("taskkill", args, { windowsHide: true }, () => {});
    return;
  }
  try {
    proc.kill();
  } catch {
    /* 已退出 */
  }
}
