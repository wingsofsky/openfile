/** MCP 工具：文库读写：信息、目录、读文档、文件名与全文搜索、写新文档。 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { detectEol, withEol } from "@openfile/protocol/eol";
import { DEFAULT_TEXT_CAP, SKIP_DIRS, atomicWriteFile, readTextScoped, resolveScoped, resolveWritePathCreating } from "../../lib/scoped.mjs";

import { ROOT, shadow } from "../context.ts";
import { realpathCanon, buildIndex, isSubsequence } from "../index-search.ts";
import { ok, fail, guard, type ToolScope } from "../tool-kit.ts";
import { SEARCHABLE_EXT } from "../tool-policy.ts";

export function registerLibraryTools({ registerTool }: ToolScope): void {
  registerTool(
    "library_info",
    {
      title: "文库信息",
      description: "当前文库的根路径、名称与版本层（影子 git）状态",
    },
    guard(async () => {
      const sh = await shadow();
      return ok({
        root: ROOT,
        name: path.basename(ROOT),
        versioning: sh.sg ? `可用（${sh.kind === "dev" ? "dev 桥影子" : sh.kind === "new" ? "本进程新建" : "与桌面 app 共享"}）` : `不可用：${sh.reason}`,
      });
    }),
  );

  registerTool(
    "list_dir",
    {
      title: "列目录",
      description: "列出文库内某目录（噪声目录 .git/node_modules 等已隐藏）",
      inputSchema: { path: z.string().default("").describe("库内相对路径，空 = 根") },
    },
    guard(async ({ path: rel }: { path: string }) => {
      const abs = resolveScoped(ROOT, rel);
      const out: Array<{ name: string; rel: string; isDir: boolean; size: number }> = [];
      for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        let isDir = ent.isDirectory();
        let st: fs.Stats;
        try {
          if (ent.isSymbolicLink()) {
            // 与 Rust list_dir_at 同口径：解链后不在库内（逃逸或悬空）的
            // 符号链接彻底不展示，防库外目标的元数据/存在性 oracle；
            // 库内链接保留，isDir/size 按目标算
            const real = realpathCanon(path.join(abs, ent.name));
            if (!real.startsWith(ROOT + path.sep)) continue;
            st = fs.statSync(real);
            isDir = st.isDirectory();
          } else {
            st = fs.statSync(path.join(abs, ent.name));
          }
        } catch {
          continue;
        }
        if (isDir && SKIP_DIRS.has(ent.name)) continue;
        if (!isDir && ent.name === ".DS_Store") continue;
        out.push({ name: ent.name, rel: rel ? `${rel}/${ent.name}` : ent.name, isDir, size: st.size });
      }
      out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      return ok(out);
    }),
  );

  registerTool(
    "read_doc",
    {
      title: "读文档",
      description: "读文库内文本文件（自动编码嗅探；默认上限 4MB）",
      inputSchema: {
        path: z.string().describe("库内相对路径"),
        max_bytes: z.number().int().positive().optional().describe("读取字节上限"),
      },
    },
    guard(async ({ path: rel, max_bytes }: { path: string; max_bytes?: number }) => {
      const r = await readTextScoped(ROOT, rel, max_bytes);
      if (r.encoding === "binary") return fail("二进制文件（用 list_dir 看大小；MCP 桥不传二进制内容）");
      const head = `# ${rel}（${r.encoding}${r.truncated ? "，已截断" : ""}，${r.size} 字节）\n\n`;
      return ok(head + r.content);
    }),
  );

  registerTool(
    "search_files",
    {
      title: "搜文件名",
      description: "按文件名/路径模糊搜索（前缀 > 包含 > 路径包含 > 子序列）",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(200).default(50),
      },
    },
    guard(async ({ query, limit }: { query: string; limit: number }) => {
      const q = query.trim().toLowerCase();
      if (!q) return ok([]);
      const hits: Array<{ rel: string; score: number }> = [];
      for (const rel of buildIndex()) {
        const lower = rel.toLowerCase();
        const name = lower.slice(lower.lastIndexOf("/") + 1);
        let score;
        if (name.startsWith(q)) score = 0;
        else if (name.includes(q)) score = 1;
        else if (lower.includes(q)) score = 2;
        else if (isSubsequence(lower, q)) score = 3;
        else continue;
        hits.push({ rel, score });
      }
      hits.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length);
      return ok(hits.slice(0, limit).map((h) => h.rel));
    }),
  );

  registerTool(
    "search_text",
    {
      title: "全文搜索",
      description:
        "在文库的文本文件里按关键词或正则搜索（含 会话/ 下的对话档案），返回命中文件、行号与上下文，新文件在前。回忆「哪天说过什么」先用它，再 read_doc 看全文",
      inputSchema: {
        query: z.string().min(1).max(200),
        regex: z.boolean().default(false).describe("按正则（不区分大小写）；默认按子串"),
        path_prefix: z.string().optional().describe("只搜这个前缀下，如 会话/"),
        limit: z.number().int().positive().max(200).default(40).describe("最多返回多少条命中"),
        context: z.number().int().min(0).max(5).default(1).describe("每条命中前后各带几行"),
      },
    },
    guard(
      async ({
        query,
        regex,
        path_prefix,
        limit,
        context,
      }: {
        query: string;
        regex: boolean;
        path_prefix?: string;
        limit: number;
        context: number;
      }) => {
        let matcher: (line: string) => boolean;
        if (regex) {
          let re: RegExp;
          try {
            re = new RegExp(query, "i");
          } catch (e) {
            return fail(`正则无效：${e instanceof Error ? e.message : String(e)}`);
          }
          matcher = (l) => re.test(l);
        } else {
          const q = query.toLowerCase();
          matcher = (l) => l.toLowerCase().includes(q);
        }
        const prefix = path_prefix ? path_prefix.replace(/^\/+/, "").replace(/\/+$/, "") + "/" : "";
        if (path_prefix) resolveScoped(ROOT, path_prefix);
        // 全文搜索要见到刚落盘的文件（会话导入），不吃 30s 缓存
        const rels = buildIndex(true)
          .filter((r) => (!prefix || r.startsWith(prefix)) && SEARCHABLE_EXT.has(path.extname(r).toLowerCase()))
          .sort()
          .reverse();
        const hits: Array<{ path: string; line: number; text: string; before: string[]; after: string[] }> = [];
        let scanned = 0;
        for (const rel of rels) {
          if (hits.length >= limit) break;
          let content: string;
          try {
            const r = await readTextScoped(ROOT, rel, DEFAULT_TEXT_CAP);
            if (r.encoding === "binary") continue;
            content = r.content;
          } catch {
            continue;
          }
          scanned++;
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < limit; i++) {
            if (!matcher(lines[i])) continue;
            hits.push({
              path: rel,
              line: i + 1,
              text: lines[i].length > 400 ? lines[i].slice(0, 400) + "…" : lines[i],
              before: lines.slice(Math.max(0, i - context), i),
              after: lines.slice(i + 1, i + 1 + context),
            });
          }
        }
        return ok({ query, regex, files_scanned: scanned, hits, truncated: hits.length >= limit });
      },
    ),
  );

  registerTool(
    "write_doc",
    {
      title: "写文档",
      description:
        "原子写整份文本文件（缺失父目录自动创建）。只用于自己新建的产出；修改他人文档请用 suggest_edit",
      inputSchema: {
        path: z.string().describe("库内相对路径"),
        content: z.string(),
      },
    },
    guard(async ({ path: rel, content }: { path: string; content: string }) => {
      // 覆盖已有文件时沿用它的换行风格：Windows 上 CRLF 检出的文档不被 agent 的 LF 整文改成 LF / 混合
      let text = content;
      try {
        const cur = await readTextScoped(ROOT, rel, 64 * 1024);
        if (cur.encoding !== "binary" && cur.content.includes("\n")) text = withEol(content, detectEol(cur.content));
      } catch {
        /* 新文件：原样写 */
      }
      atomicWriteFile(resolveWritePathCreating(ROOT, rel), text);
      return ok({ ok: true, path: rel, bytes: Buffer.byteLength(text) });
    }),
  );
}
