/** MCP server：文件名索引（搜索用，30s TTL）。 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { SKIP_DIRS } from "../lib/scoped.mjs";

import { ROOT } from "./context.ts";

/* ------------------------------------------------------------------ */
/* 文件名索引（搜索用，30s TTL）                                         */
/* ------------------------------------------------------------------ */

const MAX_INDEX = 400_000;
let indexCache: { at: number; rels: string[] } | null = null;
/**
 * 与 ROOT（canonicalRoot：Windows 用原生 realpath）同口径的 realpath，用来判「符号链接解析后仍在库内」：
 * JS 版 realpathSync 在 Windows 上保留 8.3 短名与链接目标原样的大小写，前缀比较会误判。
 */
export const realpathCanon = process.platform === "win32" ? fs.realpathSync.native : fs.realpathSync;

export function buildIndex(force = false): string[] {
  const now = Date.now();
  if (!force && indexCache && now - indexCache.at < 30_000) return indexCache.rels;
  const out: string[] = [];
  const queue = [""];
  while (queue.length > 0 && out.length < MAX_INDEX) {
    const rel = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) queue.push(childRel);
      } else if (ent.isFile()) {
        out.push(childRel);
      } else if (ent.isSymbolicLink()) {
        // 与 Rust build_index 同口径：只收「解析后仍在库内且指向普通文件」的符号链接；
        // 目录符号链接不入队（防环），读取时 resolveScoped 仍会复验。
        try {
          const real = realpathCanon(path.join(ROOT, childRel));
          if (real.startsWith(ROOT + path.sep) && fs.statSync(real).isFile()) {
            out.push(childRel);
          }
        } catch {
          /* 悬空或不可解析 → 不入索引 */
        }
      }
    }
  }
  indexCache = { at: now, rels: out };
  return out;
}

export function isSubsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i >= needle.length) return true;
  }
  return needle.length === 0;
}
