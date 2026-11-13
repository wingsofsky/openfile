/**
 * 逐字源码映射与软换行（审阅模式打字即修订的定位层）。
 *
 * 显示文字和源码不总是逐字相同：转义 `\*`、字符引用 `&#x4F60;`、引用块前缀、续行缩进、行尾空格……
 * 这里不在下游猜，由解析器给答案：
 * - 用渲染这一遍**同一个处理器的 micromark 扩展、同一份输入**再取一次事件流（解析是确定的，不会和建树漂移），
 *   收集会变成正文的 token：data、网址自动链接原样计入，行尾可计可不计（有的上下文不进正文）；
 *   转义、字符引用整个算一个「原子段」，值是解码后的字；行首前缀、行尾空格、容器前缀、标记符号都不计。
 * - 每个 mdast 文字节点按自己的位置区间取这些段（裁到区间内：任务列表会把起点后挪一位），
 *   逐段拼回去必须**恰好等于**节点的值，否则整个节点不映射——宁可不能改，也不改错。
 * - 拼对了：原样段变成带 `data-o`（源码偏移）的 span；原子段也包，另带 `data-oe`（整个记号的终点）——
 *   它能被选中、删除、替换，修订标记把整个记号包进去（`{--&#x4F60;--}`），光标只落在它两端。
 *   包 span 走 mdast 的 data.hName / hProperties，
 *   rehype-raw 重解析时元素不会和邻居文字合并。
 * - 建树后的转换（GFM 自动链接会在解码后的文字里再找网址、邮箱，中文标点紧挨网址时只有这一步认得出）
 *   拆出来的节点没有位置：按前后兄弟的位置夹出这一组在源码里的区间，把组里的文字拼起来整体对齐，再分回各节点。
 * - 软换行在这里变成 break，替代 remark-breaks：同一条正则、同样不带位置，阅读模式输出与它逐字相同；
 *   拆开的各段在审阅模式里带着自己那一段映射。remark-breaks 拆出来的节点没有位置，
 *   列表续行会因此整项不能修订。
 */
import { parse, postprocess, preprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";
import type { Nodes, PhrasingContent, Root, Text } from "mdast";
import type { TransformEdit } from "./review-transform";

type Extensions = NonNullable<NonNullable<Parameters<typeof parse>[0]>["extensions"]>;

interface SourceMapOptions {
  /** 块的源码与它在全文里的起点 */
  chunkSrc: string;
  chunkStart: number;
  /** transformChunkMapped 做过的替换（CriticMarkup → HTML），把喂给 remark 的串里的偏移折回源码 */
  edits: TransformEdit[];
}

/** 源码里的一段：变换后串里的区间 [s, e)，显示出来的文字 text */
interface Seg {
  s: number;
  e: number;
  text: string;
  atomic: boolean;
  /** 行尾：段落里进正文，有的上下文不进 */
  optional: boolean;
}

/** 文字节点值里的一段 [from, to)，来自源码（变换后串）的 [s, e) */
interface Run {
  from: number;
  to: number;
  s: number;
  e: number;
  atomic: boolean;
}

const VERBATIM = new Set(["data", "autolinkProtocol", "autolinkEmail", "literalAutolinkHttp", "literalAutolinkWww", "literalAutolinkEmail"]);
const ATOMIC = new Set(["characterEscape", "characterReference"]);
/** remark-breaks 用的同一条正则；判断有没有换行另用不带 g 的，免得 lastIndex 被带进 matchAll 漏掉第一个 */
const NEWLINE = /\r?\n|\r/g;
const HAS_NEWLINE = /[\r\n]/;

/** 事件流 → 会变成正文的段（按起点升序） */
export function sourceSegments(value: string, extensions: Extensions): Seg[] {
  const events = postprocess(parse({ extensions }).document().write(preprocess()(value, undefined, true)));
  const segs: Seg[] = [];
  let inAtomic = false;
  for (const [kind, token] of events) {
    if (inAtomic) {
      if (kind === "exit" && ATOMIC.has(token.type)) inAtomic = false;
      continue;
    }
    if (kind !== "enter") continue;
    const s = token.start.offset;
    const e = token.end.offset;
    if (ATOMIC.has(token.type)) {
      segs.push({ s, e, text: decodeString(value.slice(s, e)), atomic: true, optional: false });
      inAtomic = true;
    } else if (VERBATIM.has(token.type)) segs.push({ s, e, text: value.slice(s, e), atomic: false, optional: false });
    else if (token.type === "lineEnding") segs.push({ s, e, text: value.slice(s, e), atomic: false, optional: true });
  }
  return segs.sort((a, b) => a.s - b.s);
}

/** 文字节点的值与它区间里的段逐段对齐；对不上（或没拼满）返回 null */
export function alignText(value: string, ns: number, ne: number, segs: Seg[]): Run[] | null {
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].e <= ns) lo = mid + 1;
    else hi = mid;
  }
  const runs: Run[] = [];
  let j = 0;
  for (let k = lo; k < segs.length && segs[k].s < ne; k++) {
    const g = segs[k];
    let s = g.s;
    let e = g.e;
    let text = g.text;
    if (g.s < ns || g.e > ne) {
      // 原子段只能整段落在节点里；原样段裁到区间内（源码与显示逐字相同，按同样的长度裁）
      if (g.atomic) return null;
      s = Math.max(g.s, ns);
      e = Math.min(g.e, ne);
      text = g.text.slice(s - g.s, e - g.s);
    }
    if (!text) continue;
    if (value.startsWith(text, j)) {
      runs.push({ from: j, to: j + text.length, s, e, atomic: g.atomic });
      j += text.length;
    } else if (!g.optional) return null;
  }
  return j === value.length ? runs : null;
}

/** 值的 [from, to) 一段 → 文字节点：能映射到源码的部分各包一个 data-o span（原子段另带 data-oe），其余留作文字 */
function piecesOf(value: string, from: number, to: number, runs: Run[] | null, toSource: (t: number) => number | null, matches: (o: number, v: string) => boolean, decodes: (o: number, oe: number, v: string) => boolean): PhrasingContent[] {
  if (!runs) return [{ type: "text", value: value.slice(from, to) }];
  const out: PhrasingContent[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ type: "text", value: plain });
    plain = "";
  };
  for (const r of runs) {
    const a = Math.max(r.from, from);
    const b = Math.min(r.to, to);
    if (a >= b) continue;
    const piece = value.slice(a, b);
    if (r.atomic) {
      // 原子段整个落在这一段里才包（换行拆不开它：转义、字符引用解码出来的不是换行就是一个字）
      const o = a === r.from && b === r.to ? toSource(r.s) : null;
      const oe = o === null ? null : toSource(r.e);
      if (o === null || oe === null || !decodes(o, oe, piece)) {
        plain += piece;
        continue;
      }
      flush();
      out.push({ type: "text", value: piece, data: { hName: "span", hProperties: { dataO: String(o), dataOe: String(oe) } } });
      continue;
    }
    const o = toSource(r.s + (a - r.from));
    if (o === null || !matches(o, piece)) {
      plain += piece;
      continue;
    }
    flush();
    out.push({ type: "text", value: piece, data: { hName: "span", hProperties: { dataO: String(o) } } });
  }
  flush();
  return out;
}

export function remarkSourceMap(this: { data(key: string): unknown }, opts?: SourceMapOptions) {
  const self = this;
  return (tree: Root, file: { value?: unknown }) => {
    let segs: Seg[] | null = null;
    let toSource: (t: number) => number | null = () => null;
    let matches: (o: number, v: string) => boolean = () => false;
    let decodes: (o: number, oe: number, v: string) => boolean = () => false;
    if (opts) {
      const extensions = (self.data("micromarkExtensions") as Extensions | undefined) ?? [];
      segs = sourceSegments(String(file.value ?? ""), extensions);
      toSource = sourceOffsetFn(opts.chunkStart, opts.edits);
      matches = (o, v) => o >= opts.chunkStart && opts.chunkSrc.startsWith(v, o - opts.chunkStart);
      decodes = (o, oe, v) => o >= opts.chunkStart && oe > o && decodeString(opts.chunkSrc.slice(o - opts.chunkStart, oe - opts.chunkStart)) === v;
    }
    const preset = new WeakMap<Text, Run[] | null>();
    const walk = (node: Nodes) => {
      if (!("children" in node)) return;
      const kids = node.children as Nodes[];
      if (segs) recoverGroups(node, kids, segs, preset);
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (n.type !== "text") {
          walk(n);
          continue;
        }
        const replaced = rewriteText(n, preset.has(n) ? preset.get(n)! : segs && alignOwn(n, segs), toSource, matches, decodes);
        if (!replaced) continue;
        kids.splice(i, 1, ...replaced);
        i += replaced.length - 1;
      }
    };
    walk(tree);
  };
}

function alignOwn(n: Text, segs: Seg[]): Run[] | null {
  const ns = n.position?.start.offset;
  const ne = n.position?.end.offset;
  return ns !== undefined && ne !== undefined ? alignText(n.value, ns, ne, segs) : null;
}

/** 没有位置的文字节点，及只含这种文字的链接（自动链接转换造的）；是就把文字节点收进 out */
function positionlessTexts(n: Nodes, out: Text[]): boolean {
  if (n.position) return false;
  if (n.type === "text") {
    out.push(n);
    return true;
  }
  if (n.type !== "link" || !n.children.every((c) => c.type === "text" && !c.position)) return false;
  out.push(...(n.children as Text[]));
  return true;
}

/** 连续几个没位置的兄弟：区间夹在前后有位置的兄弟（或父节点首尾）之间，拼起来整体对齐，分回各节点 */
function recoverGroups(parent: Nodes, kids: Nodes[], segs: Seg[], preset: WeakMap<Text, Run[] | null>) {
  if (!parent.position) return;
  for (let i = 0; i < kids.length; ) {
    const texts: Text[] = [];
    let j = i;
    while (j < kids.length && positionlessTexts(kids[j], texts)) j++;
    if (j === i) {
      i++;
      continue;
    }
    const a = i > 0 ? kids[i - 1].position?.end.offset : parent.position.start.offset;
    const b = j < kids.length ? kids[j].position?.start.offset : parent.position.end.offset;
    const runs = a !== undefined && b !== undefined ? alignText(texts.map((t) => t.value).join(""), a, b, segs) : null;
    let off = 0;
    for (const t of texts) {
      preset.set(t, runs && sliceRuns(runs, off, off + t.value.length));
      off += t.value.length;
    }
    i = j;
  }
}

/** 整组的段切出 [x, y) 这一节点的部分（偏移改成节点内）；原子段被切开就不映射 */
function sliceRuns(runs: Run[], x: number, y: number): Run[] | null {
  const out: Run[] = [];
  for (const r of runs) {
    if (r.to <= x || r.from >= y) continue;
    const a = Math.max(r.from, x);
    const b = Math.min(r.to, y);
    if (r.atomic && (a !== r.from || b !== r.to)) return null;
    out.push({ from: a - x, to: b - x, s: r.atomic ? r.s : r.s + (a - r.from), e: r.atomic ? r.e : r.s + (b - r.from), atomic: r.atomic });
  }
  return out;
}

/** 一个文字节点 → 换行处拆成 break，审阅模式下各段按映射包 span；不用动就返回 null */
function rewriteText(
  n: Text,
  runs: Run[] | null,
  toSource: (t: number) => number | null,
  matches: (o: number, v: string) => boolean,
  decodes: (o: number, oe: number, v: string) => boolean,
): PhrasingContent[] | null {
  const value = n.value;
  if (!runs && !HAS_NEWLINE.test(value)) return null;
  const out: PhrasingContent[] = [];
  let start = 0;
  for (const m of value.matchAll(NEWLINE)) {
    if (m.index > start) out.push(...piecesOf(value, start, m.index, runs, toSource, matches, decodes));
    out.push({ type: "break" });
    start = m.index + m[0].length;
  }
  if (start < value.length) out.push(...piecesOf(value, start, value.length, runs, toSource, matches, decodes));
  return out;
}

/** 变换后串里的偏移 → 源码全文偏移；落在替换出的 HTML 里返回 null */
export function sourceOffsetFn(chunkStart: number, edits: TransformEdit[]): (t: number) => number | null {
  return (t) => {
    let shift = 0;
    for (const e of edits) {
      const ts = e.start + shift;
      if (t < ts) break;
      if (t < ts + e.html.length) return null;
      shift += e.html.length - (e.end - e.start);
    }
    return chunkStart + t - shift;
  };
}
