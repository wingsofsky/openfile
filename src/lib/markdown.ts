/**
 * markdown 大文档处理：分块（配合 content-visibility 渐进渲染）与 TOC 抽取。
 *
 * 用真正的 mdast 解析（micromark 内核，与 react-markdown 同源）而非正则行扫描——
 * 后者无法可靠推理 CommonMark 块结构（四反引号围栏内的三反引号、缩进代码块、
 * setext 标题、多段列表项都会误判）。现在切块点只落在**顶层块边界**之间，
 * 标题从 AST 抽取（涵盖 setext / 缩进 ATX，且天然忽略围栏内的 # 行）。
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Root, RootContent, Heading, Text } from "mdast";

export interface TocItem {
  level: number;
  text: string;
  id: string;
  /** 1-based，相对整份源文本 */
  line: number;
}

interface MdChunk {
  src: string;
  /** 该块首行在整份源文本中的 1-based 行号 */
  startLine: number;
}

function parse(src: string): Root {
  return fromMarkdown(src, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

/** 收集节点内的纯文本（标题文字用） */
function nodeText(node: RootContent): string {
  if (node.type === "text" || node.type === "inlineCode") {
    return (node as Text).value;
  }
  const kids = (node as { children?: RootContent[] }).children;
  if (kids) return kids.map(nodeText).join("");
  return "";
}

export function slugify(text: string, used: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[`*_~[\]()<>!#]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}\-_]/gu, "") || "section";
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function headingsFromTree(tree: Root): { level: number; text: string; line: number }[] {
  const out: { level: number; text: string; line: number }[] = [];
  for (const node of tree.children) {
    if (node.type === "heading") {
      const h = node as Heading;
      out.push({
        level: h.depth,
        text: nodeText(node).trim(),
        line: node.position?.start.line ?? 1,
      });
    }
  }
  return out;
}

export function extractToc(src: string): TocItem[] {
  const tree = parse(src);
  const used = new Map<string, number>();
  return headingsFromTree(tree).map((h) => ({
    ...h,
    id: slugify(h.text, used),
  }));
}

/**
 * 同一份 AST 同时给出 TOC 与分块边界，保证标题行号与切块口径一致。
 * 切块只在顶层块之间下刀，永不切进任何块级构造内部。
 */
export function analyze(src: string, targetLines = 160): { toc: TocItem[]; chunks: MdChunk[] } {
  const tree = parse(src);
  const used = new Map<string, number>();
  const toc: TocItem[] = headingsFromTree(tree).map((h) => ({
    ...h,
    id: slugify(h.text, used),
  }));

  const lines = src.split("\n");
  const totalLines = lines.length;
  if (totalLines <= targetLines * 1.5 || tree.children.length <= 1) {
    return { toc, chunks: [{ src, startLine: 1 }] };
  }

  // 每个顶层块的起始行（1-based），作为唯一合法的切点候选
  const blockStarts: number[] = [];
  for (const node of tree.children) {
    const ln = node.position?.start.line;
    if (ln) blockStarts.push(ln);
  }
  // 保证从第 1 行起
  if (blockStarts[0] !== 1) blockStarts.unshift(1);

  const chunks: MdChunk[] = [];
  let startLine = 1;
  for (const bs of blockStarts) {
    if (bs - startLine >= targetLines) {
      // 在这个顶层块前切：上一块含 [startLine, bs)
      chunks.push({
        src: lines.slice(startLine - 1, bs - 1).join("\n"),
        startLine,
      });
      startLine = bs;
    }
  }
  // 尾块
  if (startLine <= totalLines) {
    chunks.push({ src: lines.slice(startLine - 1).join("\n"), startLine });
  }
  // 极端：只有一个巨型顶层块（如一张超大表格）——退化为整篇一块
  if (chunks.length === 0) return { toc, chunks: [{ src, startLine: 1 }] };
  return { toc, chunks };
}

/** 只要分块时用 */
export function chunkMarkdown(src: string, targetLines = 160): MdChunk[] {
  return analyze(src, targetLines).chunks;
}
