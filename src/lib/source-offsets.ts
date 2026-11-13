/**
 * 渲染文字 ↔ 源码偏移（审阅模式打字即修订的定位层）。
 *
 * 正文文字由 remark 阶段按解析器的事件流逐字映射（remark-source-map.ts），已包成 `<span data-o>`。
 * 这里补两类 remark 阶段看不到的文字，规则都是「逐字等于源码切片才包」，宁可不改也不改错：
 * - 审阅标记（ins/del/mark）里的文字：按标记内文区间定位（transformChunk 只放转义过的纯文字）；
 * - 行内与块级 HTML 里的文字（rehype-raw 重解析后位置准确）：按自身的起止位置。
 * 没有完整位置的文字（插件新造的、合并出来的）一律不包；代码、公式不包。
 * 批注气泡、【给 agent 的话】整个算一个原子段（带 data-o / data-oe）：不能改字，但光标落在里面时知道该去标记哪一侧。
 * 回车后的新空段落没有文字，用一个带 data-anchor 的 span 包 <br> 给光标落脚（ProseMirror、CKEditor 也用 <br>，零宽字符会混进复制的内容）。
 */
import type { CriticSegment } from "@openfile/protocol/criticmarkup";
import type { TransformEdit } from "./review-transform";
import { sourceOffsetFn } from "./remark-source-map";
import { contentRange } from "./suggest-edit";

type HNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

const SKIP_TAGS = new Set(["code", "pre", "script", "style", "svg", "math"]);

function classes(n: HNode): string[] {
  const c = n.properties?.className;
  return Array.isArray(c) ? c.map(String) : c ? String(c).split(/\s+/) : [];
}

export function rehypeSourceOffsets(opts: {
  chunkSrc: string;
  chunkStart: number;
  /** transformChunkMapped 做过的替换 */
  edits: TransformEdit[];
  segments: CriticSegment[];
}) {
  const { chunkSrc, chunkStart, edits, segments } = opts;
  const toSource = sourceOffsetFn(chunkStart, edits);
  const matches = (o: number, value: string) =>
    o >= chunkStart && chunkSrc.slice(o - chunkStart, o - chunkStart + value.length) === value;
  const wrap = (text: HNode, o: number): HNode => ({
    type: "element",
    tagName: "span",
    properties: { dataO: String(o) },
    children: [text],
  });

  return (tree: HNode) => {
    const walk = (parent: HNode, region: [number, number] | null) => {
      const kids = parent.children;
      if (!kids) return;
      // remark 阶段已经映射过的文字
      if (parent.type === "element" && parent.tagName === "span" && parent.properties?.dataO !== undefined) return;
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (n.type === "element") {
          if (SKIP_TAGS.has(n.tagName!)) continue;
          const cls = classes(n);
          const cmid = Number(n.properties?.dataCmid);
          const cr = String(n.properties?.dataCr ?? "").split(",").map(Number);
          const hasCr = n.properties?.dataCr !== undefined;
          if (cls.includes("cm-comment") || cls.includes("agent-note")) {
            const whole = cls.includes("agent-note") ? (hasCr ? cr : null) : segments[cmid] ? [segments[cmid].start, segments[cmid].end] : null;
            if (whole) n.properties = { ...n.properties, dataO: String(whole[0]), dataOe: String(whole[1]) };
            continue;
          }
          if (cls.includes("cm-anchor") && hasCr) {
            n.children = [
              {
                type: "element",
                tagName: "span",
                properties: { dataO: String(cr[0]), dataAnchor: "" },
                children: [{ type: "element", tagName: "br", properties: {}, children: [] }],
              },
            ];
            continue;
          }
          let inner = region;
          if (hasCr) inner = [cr[0], cr[1]];
          else if (Number.isFinite(cmid) && segments[cmid]) {
            const seg = segments[cmid];
            const r = contentRange(seg);
            inner = seg.kind === "sub" ? (cls.includes("cm-del") ? r.old! : r.neu!) : [r.cs, r.ce];
          }
          walk(n, inner);
          continue;
        }
        if (n.type !== "text" || !n.value) continue;
        // 块与块之间的换行不是正文，不给光标落脚
        if (parent.type === "root" && !n.value.trim()) continue;
        const value = n.value;
        let o: number | null = null;
        if (region) {
          // 标记内文：整段一个文字节点
          if (region[1] - region[0] === value.length && matches(region[0], value)) o = region[0];
        } else {
          const ts = n.position?.start?.offset;
          const te = n.position?.end?.offset;
          if (ts !== undefined && te !== undefined && te - ts === value.length) {
            const s = toSource(ts);
            if (s !== null && matches(s, value)) o = s;
          }
        }
        if (o !== null) kids[i] = wrap(n, o);
      }
    };
    walk(tree, null);
  };
}

/* ---------------- DOM 侧 ---------------- */

function spanOf(node: Node | null): HTMLElement | null {
  const el = node?.parentElement;
  return el && el.hasAttribute("data-o") ? el : null;
}

/** 文字节点在源码里的位置：[o, end)；atomic = 转义、字符引用解码出来的字（整个记号算一个字） */
function info(t: Text): { o: number; end: number; atomic: boolean } | null {
  const span = spanOf(t);
  if (!span) return null;
  const o = Number(span.getAttribute("data-o"));
  const oe = span.getAttribute("data-oe");
  return { o, end: oe === null ? o + t.data.length : Number(oe), atomic: oe !== null };
}

/** 节点内偏移 → 源码偏移；原子段只有两端（中间的偏移归到起点） */
function at(inf: { o: number; end: number; atomic: boolean }, t: Text, offset: number): number {
  if (!inf.atomic) return inf.o + offset;
  return offset >= t.data.length ? inf.end : inf.o;
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
  return out;
}

/** 元素里的空段落落脚点（它自己，或它唯一的落点） */
function anchorIn(n: Node): HTMLElement | null {
  if (!(n instanceof HTMLElement)) return null;
  return n.matches("[data-anchor]") ? n : n.querySelector<HTMLElement>("[data-anchor]");
}

/** DOM 位置（光标 / 选区端点）→ 源码偏移；不在可编辑文字上返回 null */
export function domPointToSource(node: Node, offset: number): number | null {
  const anchored = node instanceof Element ? node.closest("[data-anchor]") : null;
  if (anchored) return Number(anchored.getAttribute("data-o"));
  if (node.nodeType === Node.TEXT_NODE) {
    const inf = info(node as Text);
    if (inf) return at(inf, node as Text, offset);
    // 不包的文字两端：紧挨着的那一段 span 换算
    const len = (node as Text).data.length;
    const next = node.nextSibling;
    if (offset === len && next instanceof HTMLElement && next.hasAttribute("data-o")) return Number(next.getAttribute("data-o"));
    const prev = node.previousSibling;
    if (offset === 0 && prev instanceof HTMLElement && prev.firstChild?.nodeType === Node.TEXT_NODE) {
      const pi = info(prev.firstChild as Text);
      if (pi) return pi.end;
    }
    return null;
  }
  // 落在元素边界上：先看前一个孩子的末尾，再看后一个孩子的开头
  const kids = node.childNodes;
  for (let i = offset - 1; i >= 0; i--) {
    const ts = textNodes(kids[i]);
    for (let j = ts.length - 1; j >= 0; j--) {
      const inf = info(ts[j]);
      if (inf) return inf.end;
      if (ts[j].data.trim()) return null;
    }
    const anchor = anchorIn(kids[i]);
    if (anchor) return Number(anchor.getAttribute("data-o"));
  }
  for (let i = offset; i < kids.length; i++) {
    for (const t of textNodes(kids[i])) {
      const inf = info(t);
      if (inf) return inf.o;
      if (t.data.trim()) return null;
    }
    const anchor = anchorIn(kids[i]);
    if (anchor) return Number(anchor.getAttribute("data-o"));
  }
  return null;
}

/**
 * 把光标放到源码偏移 c 处（同一偏移落在两段文字交界时取前一段的末尾）。
 * c 落在标记语法上、没有文字能接住时：和后一段文字之间没有换行就落到它开头（页面上是同一处），
 * 否则留在前一段末尾——比如段尾的删除标记之后，不能跳到下一段。
 */
export function placeCaret(root: HTMLElement, c: number, src: string): boolean {
  type Spot = { node: Node; off: number };
  let best: Spot | null = null;
  let before: Spot | null = null;
  let after: (Spot & { o: number }) | null = null;
  for (const span of root.querySelectorAll<HTMLElement>("span[data-o]")) {
    if (span.hasAttribute("data-anchor")) {
      const o = Number(span.getAttribute("data-o"));
      if (o === c) {
        best = { node: span, off: 0 };
        break;
      }
      if (o < c) before = { node: span, off: 0 };
      else if (!after || o < after.o) after = { node: span, off: 0, o };
      continue;
    }
    const t = span.firstChild;
    if (!t || t.nodeType !== Node.TEXT_NODE) continue;
    const inf = info(t as Text)!;
    // 气泡尾部：光标放到气泡后面的文字上，没有才留在气泡里
    if (c === inf.end && span.matches(".cm-comment, .agent-note")) {
      before = { node: t as Text, off: (t as Text).data.length };
      continue;
    }
    if (inf.o <= c && c <= inf.end) {
      best = { node: t as Text, off: inf.atomic ? (c === inf.o ? 0 : (t as Text).data.length) : c - inf.o };
      break;
    }
    if (inf.end < c) before = { node: t as Text, off: (t as Text).data.length };
    if (inf.o > c && (!after || inf.o < after.o)) after = { node: t as Text, off: 0, o: inf.o };
  }
  const pick = best ?? (after && (!before || !src.slice(c, after.o).includes("\n")) ? after : before);
  if (!pick) return false;
  const sel = window.getSelection();
  if (!sel) return false;
  const r = document.createRange();
  r.setStart(pick.node, pick.off);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}

/** 源码里的一段 [a, b)，页面上显示为 text（原子段是整个转义 / 字符引用） */
export interface Piece {
  a: number;
  b: number;
  text: string;
}

/** 删的时候不算正文、跳过：批注气泡、给 agent 的话、已经标了删除的字（删除与替换的旧文） */
const SKIP = ".cm-comment, .agent-note, del.cm-del";
/** 删字不越过的块：退格到段首就交给合并段落（join） */
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, figcaption";
/** 选区里碰到就不删：图片、复选框、公式（没有能对上的源码） */
const OPAQUE = "img, input, .katex";

/**
 * 选区 → 它盖住的正文在源码里的各段（按页面顺序）。格式符号不在任何一段里，
 * 所以跨加粗、链接的选区会得到好几段，由 suggest-edit 各包一条修订、格式原样留着。
 * 选区里有对不上源码的可见内容（代码、公式、图片）返回 null。
 */
export function rangePieces(range: Range): Piece[] | null {
  const pieces: Piece[] = [];
  const take = (t: Text, s: number, e: number): boolean => {
    if (s >= e || t.parentElement?.closest(SKIP)) return true;
    const inf = info(t);
    if (!inf) return !t.data.slice(s, e).trim();
    pieces.push(inf.atomic ? { a: inf.o, b: inf.end, text: t.data } : { a: inf.o + s, b: inf.o + e, text: t.data.slice(s, e) });
    return true;
  };
  const common = range.commonAncestorContainer;
  if (common.nodeType === Node.TEXT_NODE) return take(common as Text, range.startOffset, range.endOffset) ? pieces : null;
  const w = document.createTreeWalker(common, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    if (n.nodeType === Node.ELEMENT_NODE) {
      if ((n as Element).matches(OPAQUE)) return null;
      continue;
    }
    const t = n as Text;
    const s = t === range.startContainer ? range.startOffset : 0;
    const e = t === range.endContainer ? range.endOffset : t.data.length;
    if (!take(t, s, e)) return null;
  }
  return pieces;
}

/**
 * 光标前（back）/ 后（forward）页面上看得见的那个字在源码里的一段：跨过格式符号与已删除的字，
 * 转义出来的字整个记号算一个。碰到软换行返回 "line"，到段首段尾返回 "block"（都交给合并），碰到对不上源码的内容返回 null。
 */
export function edgePiece(node: Node, offset: number, dir: "back" | "forward"): Piece | "line" | "block" | null {
  const el = elementOf(node);
  const block = el?.closest(BLOCK);
  if (!block) return null;
  const back = dir === "back";
  /** 文字节点里紧挨着 i 的那个字；undefined = 这个节点里没有，接着往前 / 往后找 */
  const charOf = (t: Text, i: number): Piece | null | undefined => {
    if (t.parentElement?.closest(SKIP)) return undefined;
    const d = t.data;
    if (back ? i <= 0 : i >= d.length) return undefined;
    const [x, y] = back ? [prevIndex(d, i), i] : [i, nextIndex(d, i)];
    const inf = info(t);
    if (!inf) return d.slice(x, y).trim() ? null : undefined;
    if (inf.atomic) return { a: inf.o, b: inf.end, text: d };
    return { a: inf.o + x, b: inf.o + y, text: d.slice(x, y) };
  };
  const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let first: Node | null = null;
  if (node.nodeType === Node.TEXT_NODE) {
    const got = charOf(node as Text, offset);
    if (got !== undefined) return got;
    w.currentNode = node;
  } else {
    const kids = node.childNodes;
    if (back && offset > 0) first = lastDescendant(kids[offset - 1]);
    else if (!back && offset < kids.length) first = kids[offset];
    else w.currentNode = back ? node : lastDescendant(node);
  }
  for (let n: Node | null = first ?? (back ? w.previousNode() : w.nextNode()); n; n = back ? w.previousNode() : w.nextNode()) {
    if (first) {
      w.currentNode = first;
      first = null;
    }
    if (n.nodeType === Node.ELEMENT_NODE) {
      if ((n as Element).tagName === "BR" && !(n as Element).closest("[data-anchor]")) return "line";
      if ((n as Element).matches(OPAQUE)) return null;
      continue;
    }
    const t = n as Text;
    const got = charOf(t, back ? t.data.length : 0);
    if (got !== undefined) return got;
  }
  return "block";
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
}

const blank = (r: Range) => !r.toString();

/**
 * 回车落在哪：表格单元格里不能换行（"table"）；Enter 落在加粗、链接中间会把格式符号拆开（"format"）；
 * 落在格式的头尾时给出 edge，由 outOfFormat 挪到符号外面。不在可编辑文字上返回 null。
 */
export function breakSpot(node: Node, offset: number, soft: boolean): { at: number; inList: boolean; edge?: "head" | "tail" } | "table" | "format" | null {
  const el = elementOf(node);
  if (el?.closest("td, th")) return "table";
  const at = domPointToSource(node, offset);
  if (at === null) return null;
  const inList = !!el?.closest("li");
  if (soft) return { at, inList };
  let fmt: Element | null = null;
  for (let e = el?.closest(INLINE_FORMAT) ?? null; e; e = e.parentElement?.closest(INLINE_FORMAT) ?? null) fmt = e;
  if (!fmt) return { at, inList };
  const head = document.createRange();
  head.setStart(fmt, 0);
  head.setEnd(node, offset);
  if (blank(head)) return { at, inList, edge: "head" };
  const tail = document.createRange();
  tail.setStart(node, offset);
  tail.setEnd(fmt, fmt.childNodes.length);
  if (blank(tail)) return { at, inList, edge: "tail" };
  return "format";
}

const INLINE_FORMAT = "strong, em, a, s, del:not(.cm-del)";
const UNJOINABLE = "pre, table, hr, .katex-display, .math-display";

/** 段首退格 / 段尾向前删能不能合并：单元格不行，相邻的是代码块、表格、分隔线也不行 */
export function canJoinBlock(node: Node, dir: "back" | "forward"): boolean {
  const block = elementOf(node)?.closest(BLOCK);
  if (!block || block.matches("td, th, dt, dd, figcaption")) return false;
  const near = (e: Element) => (dir === "back" ? e.previousElementSibling : e.nextElementSibling);
  let cur: Element | null = block;
  let sib: Element | null = null;
  while (cur && !cur.matches("article") && !(sib = near(cur))) cur = cur.parentElement;
  if (sib?.matches("section")) sib = dir === "back" ? sib.lastElementChild : sib.firstElementChild;
  return !sib?.matches(UNJOINABLE);
}

/**
 * 把光标从已删除文字的边上挪到旁边的正文：页面上是同一处，
 * 但输入法组合期间文字会长在光标所在的节点里，留在 del 里就会带着删除线显示。
 * 要在光标停下时调（selectionchange），不能在按键时调：那时输入法已开始组合，动选区会打断它。
 */
export function leaveDeletedEdge(): void {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  const node = r.startContainer;
  const del = node.nodeType === Node.TEXT_NODE ? node.parentElement?.closest("del.cm-del") : null;
  if (!del) return;
  const len = (node as Text).data.length;
  if (r.startOffset !== 0 && r.startOffset !== len) return;
  const atEnd = r.startOffset === len;
  const side = atEnd ? del.nextSibling : del.previousSibling;
  const span = side instanceof HTMLElement && side.matches("span[data-o]:not([data-anchor])") ? side.firstChild : null;
  if (!span || span.nodeType !== Node.TEXT_NODE) return;
  const to = document.createRange();
  to.setStart(span, atEnd ? 0 : (span as Text).data.length);
  to.collapse(true);
  sel.removeAllRanges();
  sel.addRange(to);
}

function lastDescendant(n: Node): Node {
  while (n.lastChild) n = n.lastChild;
  return n;
}

function prevIndex(s: string, i: number): number {
  const c = s.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? i - 2 : i - 1;
}

function nextIndex(s: string, i: number): number {
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? i + 2 : i + 1;
}
