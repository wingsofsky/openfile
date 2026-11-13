/**
 * `openfile open <文件或文件夹>`：把路径交给已装的 Openfile 桌面端。
 *
 * 工作区推断只在桌面端一处（src-tauri/src/open_target.rs）：这里只找到桌面端、把绝对路径交过去。
 * 桌面端已在运行时由它的单实例转发接住，没在运行就启动它。
 *   OPENFILE_DESKTOP   桌面端位置（Windows 的 Openfile.exe / macOS 的 Openfile.app）；给了就只用它
 *   Windows            安装包的默认位置：%LOCALAPPDATA%\Openfile（当前用户安装）、%ProgramFiles%\Openfile（msi）
 *   macOS              `open -a`，与 Finder 双击走同一条 Apple Event 路径
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const USAGE = "用法: openfile open <文件或文件夹>\n用 Openfile 桌面端打开：文件所在的仓库（或文库）当文库打开并打开这份文档；文件夹直接当文库打开。";
const NOT_FOUND = "找不到 Openfile 桌面端";

function windowsCandidates(): string[] {
  return [process.env.LOCALAPPDATA, process.env.ProgramFiles]
    .filter((d): d is string => !!d)
    .map((d) => path.join(d, "Openfile", "Openfile.exe"));
}

async function launchDetached(exe: string, target: string): Promise<void> {
  const child = spawn(exe, [target], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return;
  }
  if (args.length !== 1) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const target = path.resolve(args[0]);
  if (!fs.existsSync(target)) throw new Error(`路径不存在：${target}`);
  const override = process.env.OPENFILE_DESKTOP;
  if (process.platform === "darwin") {
    const r = spawnSync("open", ["-a", override || "Openfile", target], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`${NOT_FOUND}（${(r.stderr || r.error?.message || "").trim()}）。装在别处时用 OPENFILE_DESKTOP 指到 Openfile.app`);
    }
  } else if (process.platform === "win32") {
    const exe = (override ? [override] : windowsCandidates()).find((p) => fs.existsSync(p));
    if (!exe) throw new Error(`${NOT_FOUND}${override ? `：${override}` : ""}。装在别处时用 OPENFILE_DESKTOP 指到 Openfile.exe`);
    await launchDetached(exe, target);
  } else {
    throw new Error(`${NOT_FOUND}：这个系统上还没有桌面端（只有 Windows 与 macOS）`);
  }
  console.log(`已交给 Openfile：${target}`);
}

main().catch((e) => {
  console.error(`[open] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
