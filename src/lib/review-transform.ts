/**
 * 审阅渲染变换：把 CriticMarkup / 【…】 替换为行内 HTML 标签，
 * 供 react-markdown（rehype-raw + sanitize 白名单）渲染成可点击的审阅标记。
 *
 * 不变量：
 * - 只做行内替换，绝不增删换行 —— 标题行号映射（TOC/锚点）保持成立
 * - 含换行的标记按行拆开：每行各出一个同 data-cmid 的元素，换行与行首的容器前缀留在外面当真 Markdown，
 *   所以它能跨段落、跨列表项，也能被分块切开（切点都在行首）。data-cr 记着这一段内文的源码区间（只给下游定位，sanitize 会去掉）
 * - 批注含空行时不变换（渲染为字面量，仍可从工具条整批处理）
 * - 内文 HTML 转义，杜绝注入（sanitize 是第二道闸）
 */
import { decodeString } from "micromark-util-decode-string";
import { agentNotes, codeRanges, parseCritic, type CriticSegment } from "@openfile/protocol/criticmarkup";
import { containerPrefix, contentRange } from "./suggest-edit";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 标记内文按 Markdown 解码转义与字符引用再显示：删掉的 `&#x4F60;` 显示成删掉的「你」 */
function shown(s: string | undefined): string {
  return escapeHtml(decodeString(s ?? ""));
}

function authorAttr(author?: string): string {
  return author ? ` data-author="${escapeHtml(author)}"` : "";
}

function renderSeg(seg: CriticSegment, id: number): string | null {
  // 批注是一个气泡，拆不开；CRLF 文档的空行是 \r\n\r\n
  if (seg.kind === "comment" && /\r?\n\r?\n/.test(seg.text)) return null;
  const a = authorAttr(seg.author);
  switch (seg.kind) {
    case "ins":
      return `<ins class="cm-ins" data-cmid="${id}"${a}>${shown(seg.text)}</ins>`;
    case "del":
      return `<del class="cm-del" data-cmid="${id}"${a}>${shown(seg.text)}</del>`;
    case "sub":
      return (
        `<del class="cm-del cm-sub" data-cmid="${id}"${a}>${shown(seg.old)}</del>` +
        `<ins class="cm-ins cm-sub" data-cmid="${id}"${a}>${shown(seg.newText)}</ins>`
      );
    case "comment":
      return `<span class="cm-comment" data-cmid="${id}"${a}>${escapeHtml(seg.text)}</span>`;
    case "mark":
      return `<mark class="cm-mark" data-cmid="${id}"${a}>${shown(seg.text)}</mark>`;
  }
}

/**
 * 对整份源文本解析一次；对单个 chunk 做替换。
 * chunkCharStart：该 chunk 在全文的字符偏移（chunks 以 '\n' 连接还原全文）。
 */
export function transformChunk(
  chunkSrc: string,
  chunkCharStart: number,
  segments: CriticSegment[],
): string {
  return transformChunkMapped(chunkSrc, chunkCharStart, segments).out;
}

export interface TransformEdit {
  /** 块内源码区间 [start, end) */
  start: number;
  end: number;
  html: string;
}

type Part = { tag: "ins" | "del" | "mark"; cls: string; a: number; b: number };

function partsOf(seg: CriticSegment): Part[] {
  const r = contentRange(seg);
  if (seg.kind === "sub") {
    return [
      { tag: "del", cls: "cm-del cm-sub", a: r.old![0], b: r.old![1] },
      { tag: "ins", cls: "cm-ins cm-sub", a: r.neu![0], b: r.neu![1] },
    ];
  }
  const [tag, cls] = seg.kind === "ins" ? (["ins", "cm-ins"] as const) : seg.kind === "del" ? (["del", "cm-del"] as const) : (["mark", "cm-mark"] as const);
  return [{ tag, cls, a: r.cs, b: r.ce }];
}

/**
 * 含换行的标记 → 按行拆成的替换（只出落在本块的行）。
 * 换行前的最后一段带 cm-break（画 ¶，可点击处理）；末行没有字、这一行后面也没别的字时带 cm-anchor，
 * 那是回车后的新空段落，Markdown 表达不了空段落，靠它占住一行、给光标落脚（source-offsets.ts）。
 */
function lineEdits(chunkSrc: string, chunkStart: number, seg: CriticSegment, id: number): TransformEdit[] {
  const parts = partsOf(seg);
  const attrs = `data-cmid="${id}"${authorAttr(seg.author)}`;
  const element = (p: Part, a: number, b: number, extra: string) =>
    `<${p.tag} class="${p.cls}${extra}" ${attrs} data-cr="${a},${b}">${shown(chunkSrc.slice(a - chunkStart, b - chunkStart))}</${p.tag}>`;
  const to = Math.min(seg.end, chunkStart + chunkSrc.length);
  const out: TransformEdit[] = [];
  for (let ls = Math.max(seg.start, chunkStart); ls <= to; ) {
    const found = chunkSrc.indexOf("\n", ls - chunkStart);
    const le = found === -1 || found + chunkStart >= to ? to : found + chunkStart;
    const more = le < seg.end;
    const textEnd = more && le > ls && chunkSrc[le - 1 - chunkStart] === "\r" ? le - 1 : le;
    const first = ls === seg.start;
    const last = !more;
    const start = first ? seg.start : ls + containerPrefix(chunkSrc.slice(ls - chunkStart, textEnd - chunkStart)).length;
    const frags = parts
      .map((p) => ({ p, a: Math.max(p.a, start), b: Math.min(p.b, textEnd) }))
      .filter((f) => f.a < f.b);
    let html = "";
    if (frags.length) {
      html = frags.map((f, i) => element(f.p, f.a, f.b, more && i === frags.length - 1 ? " cm-break" : "")).join("");
    } else if (first) {
      html = element(parts[0], parts[0].a, parts[0].a, more ? " cm-break" : "");
    } else if (last) {
      const p = parts[parts.length - 1];
      const rest = chunkSrc.slice(seg.end - chunkStart);
      html = element(p, p.b, p.b, /^[ \t]*(?:\r?\n|$)/.test(rest) ? " cm-anchor" : "");
    }
    if (html) out.push({ start: start - chunkStart, end: (more ? textEnd : seg.end) - chunkStart, html });
    if (le >= to) break;
    ls = le + 1;
  }
  return out;
}

/**
 * 同 transformChunk，另交出做过的替换（按起点升序）。
 * 审阅模式要把渲染出的文字映射回源码偏移，靠这张表把变换后的位置折算回来。
 */
export function transformChunkMapped(
  chunkSrc: string,
  chunkCharStart: number,
  segments: CriticSegment[],
): { out: string; edits: TransformEdit[] } {
  const edits: TransformEdit[] = [];
  // 块在顶层 CommonMark 块边界上切开，单独算代码区与整篇一致（codeRanges 认缩进代码、引用块与列表里的围栏）
  const protectedRanges = codeRanges(chunkSrc);
  const protectedAt = (start: number, end: number) => protectedRanges.some(([s, e]) => start < e && end > s);
  const end = chunkCharStart + chunkSrc.length;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.start >= end || seg.end <= chunkCharStart) continue;
    if (seg.kind !== "comment" && seg.text.includes("\n")) {
      if (!protectedAt(Math.max(seg.start - chunkCharStart, 0), Math.min(seg.end, end) - chunkCharStart)) {
        edits.push(...lineEdits(chunkSrc, chunkCharStart, seg, i));
      }
      continue;
    }
    if (seg.start < chunkCharStart || seg.end > end) continue; // 不完整落在本块
    const html = renderSeg(seg, i);
    if (html === null) continue;
    const s = seg.start - chunkCharStart;
    const e = seg.end - chunkCharStart;
    if (!protectedAt(s, e)) edits.push({ start: s, end: e, html });
  }
  for (const { start, end, text } of agentNotes(chunkSrc, protectedRanges)) {
    if (segments.some((s) => start + chunkCharStart < s.end && end + chunkCharStart > s.start)) continue;
    edits.push({ start, end, html: `<span class="agent-note" data-cr="${start + chunkCharStart},${end + chunkCharStart}">【${escapeHtml(text)}】</span>` });
  }
  let out = chunkSrc;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.html + out.slice(edit.end);
  }
  return { out, edits: edits.reverse() };
}

/** 全文解析入口（memo 于 MarkdownBody） */
export function analyzeReview(src: string): CriticSegment[] {
  return parseCritic(src);
}
