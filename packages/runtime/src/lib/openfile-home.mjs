/**
 * Openfile 主文件夹：导出的对话档案放在这里。默认 `~/.openfile`，环境变量 OPENFILE_HOME 可改。
 * 它本身是个文库（有 `.openfile/`），桌面端可以当文库打开，档案在 `会话/` 下。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalRoot } from "./scoped.mjs";

function openfileHomePath(env = process.env) {
  return env.OPENFILE_HOME || path.join(os.homedir(), ".openfile");
}

/** 建好主文件夹并返回规范路径 */
export function ensureOpenfileHome(env = process.env) {
  const home = openfileHomePath(env);
  fs.mkdirSync(path.join(home, ".openfile"), { recursive: true });
  return canonicalRoot(home);
}
