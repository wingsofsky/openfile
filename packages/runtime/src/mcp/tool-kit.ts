/** MCP server：工具应答辅助：ok / fail / guard、整文读取、建议定位与标记校验。 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { codeRanges, inRanges, parseCritic } from "@openfile/protocol/criticmarkup";
import { detectEol, findAllEolTolerant, type Eol } from "@openfile/protocol/eol";
import { DEFAULT_TEXT_CAP, readTextScoped } from "../lib/scoped.mjs";

import { ROOT } from "./context.ts";

/* ------------------------------------------------------------------ */
/* 工具应答辅助                                                          */
/* ------------------------------------------------------------------ */

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export const ok = (v: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }],
});
export const fail = (msg: string): ToolResult => ({
  content: [{ type: "text", text: msg }],
  isError: true,
});

/** 统一错误翻译：ScopeError/Error 的 message 直达 agent */
export function guard<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>) {
  return async (...args: A): Promise<ToolResult> => {
    try {
      return await fn(...args);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

/** 读全文（拒绝二进制/截断——审阅操作不允许在不完整内容上落盘） */
export async function readFull(rel: string): Promise<string> {
  const r = await readTextScoped(ROOT, rel, DEFAULT_TEXT_CAP);
  if (r.encoding === "binary") throw new Error("二进制文件不支持此操作");
  if (r.truncated) throw new Error("文件超过 4MB 截断上限，禁止在不完整内容上操作");
  return r.content;
}


/**
 * 唯一锚点定位：必须恰好一次出现在代码区之外。换行容错——agent 递来的锚点几乎总是 LF，
 * Windows 上的文档常是 CRLF（反之亦然），其余字符逐字一致。返回命中位置与文档里的原文（含原样换行）。
 */
export function findUniqueOutsideCode(src: string, needle: string): { at: number; text: string } {
  if (needle.length === 0) throw new Error("锚点文本不能为空");
  const hits = findAllEolTolerant(src, needle);
  if (hits.length === 0) throw new Error("目标文本未找到（必须与文档内容逐字一致，含空白）");
  const ranges = codeRanges(src);
  const outside = hits.filter((h) => !inRanges(h.index, ranges));
  if (outside.length === 0)
    throw new Error("目标文本只出现在代码区内；代码围栏/行内代码中的标记按字面量处理，不能作为建议锚点");
  if (outside.length > 1)
    throw new Error(`目标文本出现 ${outside.length} 次，请携带更长的上下文使其唯一`);
  return { at: outside[0].index, text: outside[0].text };
}

/** 写进文档的新文本沿用哪种换行：锚点跨行时随命中原文，否则随全文主导风格 */
export function eolAt(src: string, matched: string): Eol {
  if (matched.includes("\r\n")) return "\r\n";
  if (matched.includes("\n")) return "\n";
  return detectEol(src);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** 收紧建议范围：剥掉 old/new 的公共前后缀（不拆代理对，也不把 CRLF 拆成 \r | \n 两半） */
export function trimCommonAffixes(a: string, b: string) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  if (p > 0 && isHighSurrogate(a.charCodeAt(p - 1))) p--;
  if (p > 0 && a[p - 1] === "\r" && (a[p] === "\n" || b[p] === "\n")) p--;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (s > 0 && isLowSurrogate(a.charCodeAt(a.length - s))) s--;
  if (s > 0 && a[a.length - s] === "\n" && (a[a.length - s - 1] === "\r" || b[b.length - s - 1] === "\r")) s--;
  return {
    prefix: a.slice(0, p),
    oldCore: a.slice(p, a.length - s),
    newCore: b.slice(p, b.length - s),
    suffix: a.slice(a.length - s),
  };
}

/** 落盘前验证：拼好的标记必须能被解析回等价语义（防定界符注入写坏文档） */
export function verifyMarksParse(candidate: string, at: number, expect: { kind: string; old?: string; newText?: string; text?: string }[]): void {
  const segs = parseCritic(candidate).filter((s) => s.start >= at);
  for (const e of expect) {
    const hit = segs.find(
      (s) =>
        s.start >= at &&
        s.kind === e.kind &&
        (e.old === undefined || s.old === e.old) &&
        (e.newText === undefined || s.newText === e.newText) &&
        (e.text === undefined || s.text === e.text),
    );
    if (!hit)
      throw new Error(
        "建议内容包含 CriticMarkup 定界符（如 ~>、++}、<<}），会写坏标记语法；请改用 write_doc 直接写整文，或调整措辞",
      );
  }
}

export const AUTHOR_RE = /^[^\s:：{}]{1,32}$/;

/** buildServer 交给各组工具的东西：过了分组门的 registerTool */
export interface ToolScope {
  registerTool: McpServer["registerTool"];
}
