/**
 * HTML 审阅稿：agent 写的 HTML 报告 → 旁边的 `<名字>.html.review.md`，在审阅模式里直接改、批注。
 *
 * - 转换：unified（rehype-parse → rehype-remark → remark-gfm → remark-stringify），纯 JS，本机、不联网、不调模型。
 *   script / style / svg / canvas / 表单控件丢掉；表格走 GFM；内嵌的 data: 图片只留 alt（否则一张图几百 KB 进正文）；
 *   相对链接与图片保持原路径——审阅稿就在 HTML 旁边，照样能打开。
 * - 单向：原 HTML 不动，也不写回。审阅稿里的修订与批注是给 agent 的：它读稿子，把改动落回 HTML 源码。
 * - 正文里的 `&`、`<` 不转实体：选中带它们的句子批注时，渲染文字要能对上源码（同 PDF 笔记的 `&amp;` 还原）。
 * - 加粗、强调首尾的标点挪到标记外：中文的 `**……。**你` 按 CommonMark 收不住，remark 只好把「你」写成 `&#x4F60;`。
 * - 已有审阅稿就沿用（接着审），不覆盖；HTML 比审阅稿新时标 stale，由人决定要不要删掉旧稿重转。
 */
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import type { Element, Root as HastRoot, RootContent } from "hast";
import type { Nodes as MdastNodes, Root as MdastRoot } from "mdast";

const REVIEW_SUFFIX = ".review.md";

/** 整个元素连同内容丢掉：不是正文 */
const DROP = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "form", "button", "select", "textarea", "input"]);

/** `报告/x.html` → `报告/x.html.review.md` */
export function htmlReviewRelFor(htmlRel: string): string {
  return htmlRel + REVIEW_SUFFIX;
}

/** 审阅稿对应的 HTML；不是 HTML 审阅稿给 null */
export function htmlRelFor(reviewRel: string): string | null {
  if (!/\.html?\.review\.md$/i.test(reviewRel)) return null;
  return reviewRel.slice(0, -REVIEW_SUFFIX.length);
}

/** 去掉非正文元素、data: 图片换成 alt 文本 */
function prune() {
  const walk = (node: HastRoot | Element) => {
    const kept: RootContent[] = [];
    for (const child of node.children) {
      if (child.type === "comment" || child.type === "doctype") continue;
      if (child.type === "element") {
        if (DROP.has(child.tagName)) continue;
        if (child.tagName === "img" && /^data:/i.test(String(child.properties.src ?? ""))) {
          const alt = String(child.properties.alt ?? "").trim();
          if (alt) kept.push({ type: "element", tagName: "em", properties: {}, children: [{ type: "text", value: alt }] });
          continue;
        }
        walk(child);
      }
      kept.push(child);
    }
    node.children = kept as typeof node.children;
  };
  return (tree: HastRoot) => walk(tree);
}

const EDGE_PUNCT_END = /[\p{P}\p{S}]+$/u;
const EDGE_PUNCT_START = /^[\p{P}\p{S}]+/u;
/** CommonMark 判定分隔符能否收尾时的「字」：既不是空白也不是标点 */
const WORD = /[^\s\p{P}\p{S}]/u;

/**
 * `**加粗。**正文` → `**加粗**。正文`：收尾的 `**` 前是标点、后是字时不算右侧分隔符，加粗收不住，
 * mdast-util-to-markdown 会把后面那个字写成字符引用。标点挪出去，标记前后就都是字，不用实体。开头同理。
 */
function hoistEdgePunctuation() {
  const walk = (node: MdastNodes) => {
    if (!("children" in node)) return;
    const kids = node.children as MdastNodes[];
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      walk(n);
      if ((n.type !== "strong" && n.type !== "emphasis") || n.children.length === 0) continue;
      const last = n.children[n.children.length - 1];
      const next = kids[i + 1];
      if (last.type === "text" && next?.type === "text" && WORD.test(next.value.charAt(0))) {
        const m = EDGE_PUNCT_END.exec(last.value);
        if (m && m.index > 0) {
          last.value = last.value.slice(0, m.index);
          next.value = m[0] + next.value;
        }
      }
      const first = n.children[0];
      const prev = kids[i - 1];
      if (first.type === "text" && prev?.type === "text" && WORD.test(prev.value.charAt(prev.value.length - 1))) {
        const m = EDGE_PUNCT_START.exec(first.value);
        if (m && m[0].length < first.value.length) {
          first.value = first.value.slice(m[0].length);
          prev.value += m[0];
        }
      }
    }
  };
  return (tree: MdastRoot) => walk(tree);
}

/** HTML 源码 → Markdown 正文 */
export async function htmlToMarkdown(html: string): Promise<string> {
  const file = await unified()
    .use(rehypeParse)
    .use(prune)
    .use(rehypeRemark)
    .use(hoistEdgePunctuation)
    // 表格不按字符数补空格对齐：中文是全角，补出来反而歪，还平白多出一堆空格
    .use(remarkGfm, { tablePipeAlign: false })
    .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*", fences: true, rule: "-", listItemIndent: "one" })
    .process(html);
  return (
    String(file)
      // remark 为安全起见把正文里的 & 与 < 写成字符引用；审阅稿要原样，选区才能对上源码
      .replace(/&#x26;/g, "&")
      .replace(/&#x3C;/g, "<")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
