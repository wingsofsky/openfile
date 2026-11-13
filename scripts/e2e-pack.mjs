#!/usr/bin/env node
/**
 * E2E: the runtime works outside the desktop repo.
 *
 *   pnpm e2e:pack
 *
 * Builds dist/cli.mjs, packs @openfile/runtime with `pnpm pack`, installs the tarball with npm into a
 * temp directory outside the repository, then drives the installed `openfile` bin:
 *   - `openfile --version` matches the package version
 *   - `openfile mcp --root <temp library>` answers the MCP handshake and lists the tools
 *   - `openfile open` says so clearly when the desktop app is not there (OPENFILE_DESKTOP points nowhere) or the path is missing;
 *     it never launches a real app here
 * Needs network access for the three runtime dependencies (npm registry).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG_DIR = path.join(REPO, "packages", "runtime");
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
const WIN = process.platform === "win32";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failed++;
};

// pnpm sets npm_config_* for its children; the npm install below must not inherit the workspace's settings.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
// Windows needs a shell for the .cmd shims (npm, pnpm, the installed bin); pass one quoted command line.
const quote = (a) => (/^[\w.:\\/@=-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
const line = (cmd, args) => (WIN ? [[cmd, ...args].map(quote).join(" "), []] : [cmd, args]);
const run = (cmd, args, opts = {}) => {
  const [c, a] = line(cmd, args);
  return spawnSync(c, a, { encoding: "utf8", shell: WIN, env: cleanEnv, timeout: 300_000, ...opts });
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-pack-"));
if (path.resolve(work).toLowerCase().startsWith(REPO.toLowerCase())) throw new Error("temp dir must be outside the repo");

try {
  console.log(`\n打包 ${pkg.name}@${pkg.version}`);
  const built = run(process.execPath, [path.join(PKG_DIR, "scripts", "build.mjs"), "--cli"]);
  check("构建 dist/cli.mjs", built.status === 0, built.stderr);
  const packed = run("pnpm", ["pack", "--pack-destination", work], { cwd: PKG_DIR });
  const tgz = fs.readdirSync(work).find((n) => n.endsWith(".tgz"));
  check("pnpm pack 产出 tarball", packed.status === 0 && !!tgz, packed.stderr || packed.stdout);
  if (!tgz) throw new Error("no tarball");

  const app = path.join(work, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "openfile-pack-e2e", private: true }));
  const inst = run("npm", ["install", "--no-audit", "--no-fund", "--omit=dev", path.join(work, tgz)], { cwd: app });
  check("npm 在仓库外安装 tarball", inst.status === 0, (inst.stderr || "").trim().split("\n").slice(-5).join("\n      "));

  const installed = path.join(app, "node_modules", "@openfile", "runtime");
  const files = fs.existsSync(installed) ? fs.readdirSync(installed).sort() : [];
  // README 是 npm 页面上的 CLI 说明；LICENSE 视 pnpm 版本可能带上
  check("包里只有 dist、README 与清单", ["LICENSE,README.md,dist,package.json", "README.md,dist,package.json"].includes(files.join(",")), files.join(","));
  check("没有把 @openfile/protocol 当依赖装进来", !fs.existsSync(path.join(app, "node_modules", "@openfile", "protocol")));

  const bin = path.join(app, "node_modules", ".bin", WIN ? "openfile.cmd" : "openfile");
  check("bin openfile 已链接", fs.existsSync(bin), bin);
  const openfile = (args, opts = {}) => run(bin, args, { cwd: work, ...opts });

  const v = openfile(["--version"]);
  check("openfile --version", v.status === 0 && v.stdout.trim() === pkg.version, `${v.status} ${v.stdout}${v.stderr}`);

  const lib = path.join(work, "library");
  fs.mkdirSync(lib);
  fs.writeFileSync(path.join(lib, "a.md"), "# hello\n");
  const hs = await handshake(bin, ["mcp", "--root", lib]);
  check("openfile mcp 握手（initialize）", hs.serverInfo?.name === "openfile" && hs.serverInfo?.version === pkg.version, JSON.stringify(hs));
  check("openfile mcp 默认列出读文件、审阅、快照 13 个工具", hs.tools === 13, JSON.stringify(hs));
  const hsAll = await handshake(bin, ["mcp", "--root", lib, "--tools", "all"]);
  check("openfile mcp --tools all 与默认一致", hsAll.tools === 13, JSON.stringify(hsAll));

  // OPENFILE_DESKTOP 指向不存在的位置，只用它、不去找真装的桌面端
  const noDesktop = { env: { ...cleanEnv, OPENFILE_DESKTOP: path.join(work, "missing", WIN ? "Openfile.exe" : "Openfile.app") } };
  const open = openfile(["open", path.join(lib, "a.md")], noDesktop);
  check("openfile open 找不到桌面端时报清楚", open.status === 1 && /找不到 Openfile 桌面端/.test(open.stderr), `${open.status} ${open.stdout}${open.stderr}`);
  const gone = openfile(["open", path.join(lib, "missing.md")], noDesktop);
  check("openfile open 路径不存在时报清楚", gone.status === 1 && /路径不存在/.test(gone.stderr), `${gone.status} ${gone.stdout}${gone.stderr}`);
} catch (e) {
  check("运行", false, e instanceof Error ? e.stack : String(e));
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}

console.log(failed ? `\n结果：${failed} 项失败 ✗` : "\n结果：全部通过 ✓");
process.exit(failed ? 1 : 0);

function handshake(cmd, args) {
  return new Promise((resolve) => {
    const [c, a] = line(cmd, args);
    const child = spawn(c, a, { shell: WIN, env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const out = {};
    const done = (extra = {}) => {
      clearTimeout(timer);
      child.kill();
      resolve({ ...out, ...extra });
    };
    const timer = setTimeout(() => done({ error: "timeout", stderr }), 60_000);
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => done({ error: `exited ${code}`, stderr }));
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          out.serverInfo = m.result?.serverInfo;
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
        } else if (m.id === 2) {
          out.tools = m.result?.tools?.length;
          done();
        }
      }
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-pack", version: "0" } } }) + "\n",
    );
  });
}
