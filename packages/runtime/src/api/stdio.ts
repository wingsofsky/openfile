/**
 * `openfile serve --stdio`：桌面端的 sidecar。Rust 宿主拉起本进程，经 stdin/stdout 走行分隔的 JSON-RPC 2.0：
 *
 *   请求  {"jsonrpc":"2.0","id":7,"method":"fs.list","params":{"ws":"main","rel":""}}
 *   响应  {"jsonrpc":"2.0","id":7,"result":[…]}  或  {"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"…","data":{"status":409}}}
 *   事件  {"jsonrpc":"2.0","method":"event","params":{"ws":"main","type":"library-changed","paths":[…]}}（无 id 的通知）
 *
 * stdout 只写帧：console.log 一律改道 stderr。stdin 关闭（宿主退出）= 关掉所有窗口、杀掉会话进程后退出。
 *
 *   --settings <file>   settings.json（默认 Tauri app_config_dir 下的同名文件）
 *   --app-data <dir>    应用数据目录（默认 folderAppData()）
 */
import path from "node:path";
import readline from "node:readline";
import { Host, appConfigDir } from "./host.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i === -1 ? undefined : argv[i + 1];
};

if (!argv.includes("--stdio")) {
  console.error("用法: openfile serve --stdio [--settings <file>] [--app-data <dir>]");
  process.exit(2);
}

// stdout 是帧通道：任何模块的 console.log / info 都改到 stderr
console.log = console.error;
console.info = console.error;

const send = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);

const host = new Host({
  settingsFile: opt("--settings") ?? path.join(appConfigDir(), "settings.json"),
  appData: opt("--app-data"),
  cliEntry: process.argv[1],
  emit: (ws, e) => send({ jsonrpc: "2.0", method: "event", params: { ws, ...e } }),
});

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: { id?: unknown; method?: unknown; params?: unknown };
  try {
    req = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "帧不是 JSON" } });
    return;
  }
  const id = req.id;
  if (typeof req.method !== "string") {
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32600, message: "缺少 method" } });
    return;
  }
  host.call(req.method, req.params).then(
    (result) => {
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: result ?? null });
    },
    (e: unknown) => {
      const err = e as { message?: string; status?: number };
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32000, message: err?.message ?? String(e), data: { status: err?.status ?? 500 } } });
      }
    },
  );
});
rl.on("close", () => {
  host.shutdown();
  process.exit(0);
});
