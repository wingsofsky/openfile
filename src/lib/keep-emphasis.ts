/**
 * 改完别让加粗、斜体失效。CommonMark 的分隔符规则对中文不友好：
 * `**……。**&#x4F60;好` 删掉「你」就成了 `**……。**好`——收尾的 `**` 前是标点、后是字，加粗收不住，页面上露出星号。
 * 做法：改动所在的段落，改前改后各数一遍强调（micromark 的 strong / emphasis）；少了就把改动边界上
 * 紧挨分隔符的那个字写成字符引用（和 remark 序列化时的做法一样），数回来了才用，修不回来就原样返回。
 * 审阅模式里的修订标记本身是标点（`{--…--}`），不会碰上这事；接受 / 拒绝修订时才会。
 */
import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";
import { applySegment, parseCritic, type CriticSegment } from "@openfile/protocol/criticmarkup";

const extensions = [gfm()];
const BLANK_LINE = /\r?\n[ \t]*\r?\n/g;
const WORD = /[^\s\p{P}\p{S}]/u;

function emphasisCount(text: string): number {
  const events = postprocess(parse({ extensions }).document().write(preprocess()(text, undefined, true)));
  let n = 0;
  for (const [kind, token] of events) if (kind === "enter" && (token.type === "strong" || token.type === "emphasis")) n++;
  return n;
}

/** p 所在段落（空行之间）的区间 */
function blockAround(s: string, p: number): [number, number] {
  let start = 0;
  BLANK_LINE.lastIndex = 0;
  for (let m = BLANK_LINE.exec(s); m && m.index < p; m = BLANK_LINE.exec(s)) start = m.index + m[0].length;
  BLANK_LINE.lastIndex = Math.max(p, start);
  const m = BLANK_LINE.exec(s);
  return [Math.min(start, p), m ? m.index : s.length];
}

function encodeAt(s: string, i: number): { text: string; at: number; delta: number } {
  const cp = s.codePointAt(i)!;
  const len = cp > 0xffff ? 2 : 1;
  const ref = `&#x${cp.toString(16).toUpperCase()};`;
  return { text: s.slice(0, i) + ref + s.slice(i + len), at: i, delta: ref.length - len };
}

const isDelim = (c: string | undefined) => c === "*" || c === "_";

/**
 * before → after 是一次拼接：after 里 [from, from + insertedLen) 是新放进去的内容。
 * 返回修好的文本；at / delta = 在哪一位把字写成了字符引用、长度多了多少（没改则 delta 为 0）。
 */
export function keepEmphasis(before: string, after: string, from: number, insertedLen: number): { text: string; at: number; delta: number } {
  const same = { text: after, at: from, delta: 0 };
  const [bs, be] = blockAround(after, from);
  const want = emphasisCount(before.slice(bs, be + before.length - after.length));
  const count = (s: string, delta: number) => emphasisCount(s.slice(bs, be + delta));
  if (count(after, 0) >= want) return same;
  // 边界两侧：紧挨分隔符的字
  const spots = new Set<number>();
  for (const q of [from, from + insertedLen]) {
    if (q < after.length && WORD.test(after[q]) && isDelim(after[q - 1])) spots.add(q);
    if (q > 0 && WORD.test(after[q - 1]) && isDelim(after[q])) spots.add(q - 1);
  }
  for (const i of spots) {
    const fixed = encodeAt(after, i);
    if (count(fixed.text, fixed.delta) >= want) return fixed;
  }
  return same;
}

/** 接受 / 拒绝一条修订，并保住它两边的加粗、斜体 */
export function resolveMark(src: string, seg: CriticSegment, accept: boolean): string {
  const next = applySegment(src, seg, accept);
  return keepEmphasis(src, next, seg.start, next.length - (src.length - (seg.end - seg.start))).text;
}

/** 全部接受 / 全部拒绝：从后往前一条一条来，每条之后重新解析（修加粗可能挪动前面的偏移） */
export function resolveAll(src: string, accept: boolean): string {
  let out = src;
  // 上限防万一：解掉一条后内文恰好又拼出标记语法时不打转
  for (let segs = parseCritic(out), left = segs.length * 2 + 1; segs.length && left > 0; segs = parseCritic(out), left--) {
    out = resolveMark(out, segs[segs.length - 1], accept);
  }
  return out;
}
