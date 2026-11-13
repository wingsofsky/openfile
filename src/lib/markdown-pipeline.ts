/**
 * md 渲染的插件链（MarkdownView 每块一份；测试从这里取，跑的和界面是同一条链）。
 *
 * 阅读与审阅只差两处：审阅模式把 remark-source-map 的逐字映射打开，并在 rehype 阶段补审阅标记与 HTML 里的文字。
 * 软换行一律由 remark-source-map 变成 break（替代 remark-breaks，输出相同）。
 */
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import type { CriticSegment } from "@openfile/protocol/criticmarkup";
import { transformChunkMapped } from "./review-transform";
import { remarkSourceMap } from "./remark-source-map";
import { rehypeSourceOffsets } from "./source-offsets";

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "ins", "del", "mark"],
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-./, "math-inline", "math-display"],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", "math-inline", "cm-comment", "agent-note"],
      "dataCmid",
      "dataAuthor",
      "dataO",
      "dataOe",
      "dataAnchor",
    ],
    div: [...(defaultSchema.attributes?.div ?? []), ["className", "math-display"]],
    input: [["type"], ["checked"], ["disabled"]],
    ins: [["className", "cm-ins", "cm-sub", "cm-break", "cm-anchor"], "dataCmid", "dataAuthor"],
    del: [["className", "cm-del", "cm-sub", "cm-break", "cm-anchor"], "dataCmid", "dataAuthor"],
    mark: [["className", "cm-mark", "cm-break", "cm-anchor"], "dataCmid", "dataAuthor"],
  },
} as typeof defaultSchema;

/** 一块的渲染输入：喂给 react-markdown 的串与两组插件（rehype 组末尾由调用方再接自己的插件） */
export function chunkPipeline(chunkSrc: string, chunkStart: number, segments: CriticSegment[], review: boolean) {
  // 开头的 BOM：micromark 跳过它却不计偏移，整块位置会小一位。先剥掉，起点后挪一位
  if (chunkSrc.charCodeAt(0) === 0xfeff) {
    chunkSrc = chunkSrc.slice(1);
    chunkStart += 1;
  }
  const mapped = transformChunkMapped(chunkSrc, chunkStart, segments);
  const sourceMap = review ? { chunkSrc, chunkStart, edits: mapped.edits } : undefined;
  return {
    text: mapped.out,
    // react-markdown 的插件表类型过严（元组里的 options），这里按 unknown[] 交出去
    remarkPlugins: [remarkGfm, remarkMath, [remarkSourceMap, sourceMap]] as unknown[],
    rehypePlugins: [
      rehypeRaw,
      ...(review ? [[rehypeSourceOffsets, { chunkSrc, chunkStart, edits: mapped.edits, segments }]] : []),
      [rehypeSanitize, sanitizeSchema],
      rehypeKatex,
    ] as unknown[],
  };
}
