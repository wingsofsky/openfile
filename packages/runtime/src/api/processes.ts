/**
 * 会话进程管道（ACP 会话）：spawn + stdio 原样转发。协议不在这里——唯一实现在前端 agent-controller。
 *
 * 进程编号由调用方（前端）生成并在 spawn 前登记好接收端，所以事件不会早于编号到达；输出以事件推送：
 *   {type:"proc", pid, stream:"stdout", b64} · {type:"proc", pid, stream:"stderr", line} · {type:"proc", pid, stream:"exit", code}
 * stderr 按行、单行截到 4000 字符；结束会话先关 stdin，再杀整棵进程树（Windows taskkill /T）。
 * 应请求杀掉的进程不报退出码：Windows 上 taskkill /F 让它以 1 退出，那不是 agent 自己的失败。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killProcessTree, resolveSpawnCommand } from "../lib/spawn-command.mjs";

export type ProcEvent =
  | { type: "proc"; pid: string; stream: "stdout"; b64: string }
  | { type: "proc"; pid: string; stream: "stderr"; line: string }
  | { type: "proc"; pid: string; stream: "exit"; code: number | null };

const STDERR_LINE_CAP = 4000;
const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface Proc {
  child: ChildProcess;
  done: boolean;
  killRequested: boolean;
}

/**
 * Windows 上 PATH 里没找到的裸命令名会原样交给 spawn，而 libuv 找程序时先看 cwd，cwd 就是打开的文件夹。
 * 文件夹里有同名程序就返回它的路径，调用方据此拒绝：打开的文件夹不能决定启动哪个程序。其它平台按 PATH 找，不看 cwd。
 */
export function programInFolder(file: string, cwd: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32" || /[\\/]/.test(file)) return null;
  for (const ext of ["", ".com", ".exe"]) {
    const full = path.join(cwd, file + ext);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // 没有这个文件
    }
  }
  return null;
}

export class ProcessTable {
  private procs = new Map<string, Proc>();

  private emit: (e: ProcEvent) => void;

  constructor(emit: (e: ProcEvent) => void) {
    this.emit = emit;
  }

  spawn(pid: string, cmd: string, args: string[], cwd: string): void {
    if (typeof pid !== "string" || !PID_RE.test(pid)) throw Object.assign(new Error("进程编号无效"), { status: 400 });
    if (this.procs.has(pid)) throw Object.assign(new Error("进程编号已占用"), { status: 409 });
    if (typeof cmd !== "string" || cmd.length === 0) throw Object.assign(new Error("缺少 cmd"), { status: 400 });
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw Object.assign(new Error("args 必须是字符串数组"), { status: 400 });
    }
    // Windows：npx / gemini 这类 .cmd 垫片还原成 node + JS 入口；mac/Linux 原样
    const target = resolveSpawnCommand(cmd, args);
    if (programInFolder(target.file, cwd)) {
      throw Object.assign(new Error(`打开的文件夹里有同名程序，不从这里启动 ${cmd}`), { status: 403 });
    }
    const child = spawn(target.file, target.args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const p: Proc = { child, done: false, killRequested: false };
    this.procs.set(pid, p);
    child.stdout!.on("data", (chunk: Buffer) => this.emit({ type: "proc", pid, stream: "stdout", b64: chunk.toString("base64") }));
    let errBuf = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      errBuf += chunk.toString("utf-8");
      let i: number;
      while ((i = errBuf.indexOf("\n")) !== -1) {
        this.emit({ type: "proc", pid, stream: "stderr", line: errBuf.slice(0, i).replace(/\r$/, "").slice(0, STDERR_LINE_CAP) });
        errBuf = errBuf.slice(i + 1);
      }
    });
    child.stdin!.on("error", () => {}); // 进程先退出时写入报 EPIPE：退出事件会报告
    const finish = (code: number | null, note?: string) => {
      if (p.done) return;
      p.done = true;
      if (note) this.emit({ type: "proc", pid, stream: "stderr", line: note });
      this.emit({ type: "proc", pid, stream: "exit", code });
      this.procs.delete(pid);
    };
    child.on("error", (e) => finish(null, `spawn 失败: ${e.message}`));
    child.on("close", (code) => finish(p.killRequested && process.platform === "win32" && code === 1 ? null : code));
  }

  write(pid: string, data: string): void {
    const p = this.procs.get(pid);
    if (!p || p.done) throw Object.assign(new Error("会话进程已退出"), { status: 404 });
    if (typeof data !== "string") throw Object.assign(new Error("缺少 data"), { status: 400 });
    p.child.stdin!.write(data);
  }

  kill(pid: string, sync = false): void {
    const p = this.procs.get(pid);
    if (!p || p.done) return;
    p.killRequested = true;
    try {
      p.child.stdin!.end();
    } catch {
      /* 已关 */
    }
    killProcessTree(p.child, { sync });
  }

  killAll(sync = false): void {
    for (const pid of [...this.procs.keys()]) this.kill(pid, sync);
  }
}
