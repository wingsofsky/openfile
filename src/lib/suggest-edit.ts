/**
 * 审阅模式打字即修订内核：人在渲染视图里插入、替换、删除，
 * 一律翻译成源码上的 CriticMarkup 拼接——源码是唯一真相，未触及的字节原样保留。
 *
 * 输入是源码偏移（渲染文字 → 源码偏移的映射在 source-offsets.ts），输出新全文与光标的源码偏移。
 * Word 式语义（只对「本人」的建议生效）：
 * - 在自己的插入（或自己替换的新文本）里打字 / 删字 = 直接改它，删空就撤掉整条
 * - 紧挨着自己插入的位置继续打字 = 接在那条插入上，不新开标记
 * - 连续退格 / 向前删除 = 并进紧邻的自己那条删除
 * - 光标落在别的标记上也能打字：内文两端挪到标记外，中间拆成两条（作者不变），新字夹在中间。
 *   页面上同一个光标位置可能对应标记内外好几个偏移，所以这里不能拒绝；全部接受 / 全部拒绝的结果与拆之前相同
 * - 删改别人的建议、批注、代码区里不动手，给人话提示（CriticMarkup 不能嵌套）
 * 换行也是修订：换行符就写在插入标记里（breakText / pasteText 给出带容器前缀的文本），渲染见 review-transform.ts；
 * 合并段落写成对换行的删除（join）。
 * 选区删除 / 替换、退格删字按页面上看得见的字来（source-offsets.ts 的 rangePieces / edgePiece 给出各段源码区间）：
 * 跨加粗、链接的选区拆成几段各包一条修订，格式符号原样留着；转义、字符引用整个记号算一个字。
 */
import { codeRanges, makeCritic, parseCritic, type CriticSegment } from "@openfile/protocol/criticmarkup";

export type EditOp =
  /** at === end 为插入，否则为用 text 替换 [at, end) */
  | { kind: "insert"; at: number; end: number; text: string; rendered?: string }
  /** at === end 为删一个字（dir 决定方向），否则删 [at, end) */
  | { kind: "delete"; at: number; end: number; dir: "back" | "forward"; rendered?: string }
  /** 删掉（text 非空则替换）页面上选中 / 退格到的字：pieces 是它们在源码里的各段 */
  | { kind: "pieces"; pieces: Array<{ a: number; b: number }>; text: string; dir: "back" | "forward" }
  /** 在行首退格 / 行尾向前删：合并这一行与相邻的上（下）一行 */
  | { kind: "join"; at: number; dir: "back" | "forward" };

/** 一次操作的起点（撤销时光标回到这里） */
export function opStart(op: EditOp): number {
  return op.kind === "pieces" ? Math.min(...op.pieces.map((p) => p.a)) : op.at;
}

type EditResult = { ok: true; next: string; caret: number } | { ok: false; error: string };

/** 标记内文在源码里的区间（去掉花括号与作者前缀）；sub 另给旧 / 新两段 */
export function contentRange(seg: CriticSegment): {
  cs: number;
  ce: number;
  old?: [number, number];
  neu?: [number, number];
} {
  const ce = seg.end - 3;
  const cs = ce - seg.text.length;
  if (seg.kind !== "sub") return { cs, ce };
  const oldEnd = cs + (seg.old ?? "").length;
  return { cs, ce, old: [cs, oldEnd], neu: [oldEnd + 2, ce] };
}

/** 本人可直接改字的区间：自己的插入内文，或自己替换里的新文本 */
function ownRange(seg: CriticSegment, author: string): [number, number] | null {
  if (seg.author !== author) return null;
  const r = contentRange(seg);
  if (seg.kind === "ins") return [r.cs, r.ce];
  if (seg.kind === "sub") return r.neu!;
  return null;
}

const DELIM = /\{(\+\+|--|~~|>>|==)|(\+\+|--|~~|<<|==)\}|~>/;

/** 行首的容器前缀：引用符、列表记号、任务框、缩进（渲染时留给 Markdown，换行时照抄） */
export function containerPrefix(line: string): string {
  return /^(?:[ \t]*(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?))*[ \t]*/.exec(line)![0];
}

const LIST_MARKER = /[-+*]|\d{1,9}[.)]/g;
const hasMarker = (prefix: string) => prefix.search(LIST_MARKER) !== -1;

/** 续行的前缀：引用符照抄，列表记号与任务框换成等宽空格 */
function continuation(prefix: string): string {
  return prefix.replace(/\[[ xX]\][ \t]+$/, "").replace(LIST_MARKER, (m) => " ".repeat(m.length));
}

/** 下一个列表项的前缀：序号加一，任务框清空，外层记号换成空格 */
function nextItem(prefix: string): string {
  const last = [...prefix.matchAll(LIST_MARKER)].at(-1)!;
  const mk = last[0];
  const next = /\d/.test(mk) ? `${Number(mk.slice(0, -1)) + 1}${mk.slice(-1)}` : mk;
  return continuation(prefix.slice(0, last.index)) + next + prefix.slice(last.index + mk.length).replace(/\[[ xX]\]/, "[ ]");
}

/** at 所在行 [起点, 终点)，终点不含行尾的换行 */
function lineAround(full: string, at: number): [number, number] {
  const ls = at > 0 ? full.lastIndexOf("\n", at - 1) + 1 : 0;
  const nl = full.indexOf("\n", at);
  if (nl === -1) return [ls, full.length];
  return [ls, nl > ls && full[nl - 1] === "\r" ? nl - 1 : nl];
}

/** at 这一行的容器前缀；列表项的续行没有记号，往上找到它的记号行 */
function prefixAt(full: string, at: number, inList: boolean): string {
  let [ls, le] = lineAround(full, at);
  let prefix = containerPrefix(full.slice(ls, le));
  while (inList && !hasMarker(prefix) && ls > 0) {
    [ls, le] = lineAround(full, ls - 1);
    prefix = containerPrefix(full.slice(ls, le));
  }
  return prefix;
}

const eolOf = (full: string) => (full.includes("\r\n") ? "\r\n" : "\n");

/** 在 at 处回车要插入的文本。soft = Shift+Enter；inList = 光标在列表项里（由 DOM 判断） */
export function breakText(full: string, at: number, soft: boolean, inList: boolean): string {
  const eol = eolOf(full);
  const prefix = prefixAt(full, at, inList);
  const cont = continuation(prefix);
  const [ls, le] = lineAround(full, at);
  // 标题只能占一行：软换行也得分段
  const heading = /^#{1,6}(?: |$)/.test(full.slice(ls + containerPrefix(full.slice(ls, le)).length, le));
  if (soft && !heading) return eol + cont;
  if (inList && hasMarker(prefix)) return eol + nextItem(prefix);
  if (cont.includes(">")) return eol + cont.trimEnd() + eol + cont;
  return eol + eol;
}

/** 粘贴多行：每行补上这里的容器前缀，换行符跟随文档 */
export function pasteText(full: string, at: number, text: string, inList: boolean): string {
  const eol = eolOf(full);
  const cont = continuation(prefixAt(full, at, inList));
  return text
    .split(/\r?\n/)
    .map((line, i) => (i === 0 ? line : eol + (line ? cont + line : cont.trimEnd())))
    .join("");
}

/** 光标在加粗、链接等格式的开头（head）/ 末尾（tail）：挪到格式符号外面，分段才不会把符号拆开 */
export function outOfFormat(full: string, at: number, edge: "head" | "tail"): number {
  if (edge === "tail") return at + /^[*_~]*(?:\]\([^)\n]*\))?[*_~]*/.exec(full.slice(at))![0].length;
  let p = at;
  while (p > 0 && /[*_~[]/.test(full[p - 1])) p--;
  return p;
}

function inCode(code: Array<[number, number]>, a: number, b: number): boolean {
  return code.some(([s, e]) => (a === b ? a > s && a < e : a < e && b > s));
}

/** 在本人建议区内拼字后整条重写；内文删空时插入撤掉、替换退回成删除 */
function rewriteOwn(full: string, seg: CriticSegment, author: string, a: number, b: number, text: string): EditResult {
  const own = ownRange(seg, author)!;
  const content = full.slice(own[0], a) + text + full.slice(b, own[1]);
  if (DELIM.test(content)) return { ok: false, error: "内容包含标记定界符（如 ~>、--}），会写坏标记语法——换个措辞" };
  if (content === "") {
    const repl = seg.kind === "sub" ? makeCritic.del(seg.old ?? "", author) : "";
    return { ok: true, next: full.slice(0, seg.start) + repl + full.slice(seg.end), caret: seg.start };
  }
  return { ok: true, next: full.slice(0, a) + text + full.slice(b), caret: a + text.length };
}

/**
 * 光标落在一条不能直接改字的标记上时，新字放哪：数字 = 挪到这个源码位置；两段文本 = 把标记拆成这两段，新字夹在中间。
 * 拆的时候作者不变，全部接受 / 全部拒绝的结果都与拆之前相同。
 */
function spotInMark(full: string, seg: CriticSegment, p: number, author: string): number | [string, string] {
  const { cs, ce, old, neu } = contentRange(seg);
  if (seg.kind === "comment" || p >= ce) return seg.end;
  if (p <= cs) return seg.start;
  const open = full.slice(seg.start, cs);
  const close = full.slice(ce, seg.end);
  if (seg.kind !== "sub") return [full.slice(seg.start, p) + close, open + full.slice(p, seg.end)];
  if (p < old![1]) return [makeCritic.del(full.slice(cs, p), seg.author), open + full.slice(p, seg.end)];
  // 旧文与新文之间（页面上紧挨着）：自己的替换接到新文开头，别人的拆成一删一插
  if (p <= neu![0]) {
    if (seg.author === author) return neu![0];
    const after = full.slice(neu![0], ce);
    return [makeCritic.del(full.slice(cs, old![1]), seg.author), after ? makeCritic.ins(after, seg.author) : ""];
  }
  return [full.slice(seg.start, p) + close, makeCritic.ins(full.slice(p, ce), seg.author)];
}

/** 合并 at 这一行与上（下）一行：自己插入的换行直接撤掉，原有的换行记成一条删除 */
function planJoin(full: string, op: Extract<EditOp, { kind: "join" }>, author: string): EditResult {
  const END = { ok: false as const, error: "已经到头了" };
  let p = op.at;
  if (op.dir === "forward") {
    // 下一个有内容的行，转成从那一行往回合并
    let [, le] = lineAround(full, p);
    for (;;) {
      const nl = full.indexOf("\n", le);
      if (nl === -1) return END;
      const [ls, e] = lineAround(full, nl + 1);
      p = ls + containerPrefix(full.slice(ls, e)).length;
      if (p < e) break;
      le = e;
    }
  }
  const [ls, le] = lineAround(full, p);
  if (ls === 0) return END;
  const body = ls + containerPrefix(full.slice(ls, le)).length;
  // 上一个有内容的行的行尾；只有容器前缀的空行、行尾的硬换行记号都算进这次合并
  let a = ls - 1;
  for (;;) {
    if (a > 0 && full[a - 1] === "\r") a--;
    const prev = a > 0 ? full.lastIndexOf("\n", a - 1) + 1 : 0;
    const line = full.slice(prev, a);
    if (containerPrefix(line).length < line.length) break;
    if (prev === 0) return END;
    a = prev - 1;
  }
  while (full[a - 1] === " " || full[a - 1] === "\t") a--;
  if (full[a - 1] === "\\") a--;

  const nl = ls - 1;
  const host = parseCritic(full).find((s) => s.start <= nl && nl < s.end);
  if (host) {
    const own = ownRange(host, author);
    if (own && own[0] <= nl && nl < own[1]) return rewriteOwn(full, host, author, Math.max(a, own[0]), Math.min(body, own[1]), "");
    if (host.kind === "del" || host.kind === "sub") return { ok: false, error: "这里的分段已经标了删除——先接受/拒绝它" };
    return { ok: false, error: "这里是别人的建议或批注——先接受/拒绝它" };
  }
  if (inCode(codeRanges(full), a, body)) return { ok: false, error: "代码围栏/行内代码里的标记是字面量，不支持在此修订" };
  const del = makeCritic.del(full.slice(a, body), author);
  return { ok: true, next: full.slice(0, a) + del + full.slice(body), caret: a + del.length };
}

export function planEdit(full: string, op: EditOp, author: string): EditResult {
  if (op.kind === "pieces") return planPieces(full, op, author);
  if (op.kind === "join") return planJoin(full, op, author);
  const segs = parseCritic(full);
  const code = codeRanges(full);
  const inside = (p: number) => segs.find((s) => s.start < p && p < s.end);
  const overlapping = (a: number, b: number) => segs.find((s) => a < s.end && b > s.start);

  if (op.kind === "insert") {
    const { at, end, text } = op;
    if (!text) return planEdit(full, { kind: "delete", at, end, dir: "back", rendered: op.rendered }, author);
    if (DELIM.test(text)) return { ok: false, error: "内容包含标记定界符（如 ~>、--}），会写坏标记语法——换个措辞" };
    if (inCode(code, at, end)) return { ok: false, error: "代码围栏/行内代码里的标记是字面量，不支持在此修订" };

    if (at === end) {
      let p = at;
      const host = inside(at);
      if (host) {
        const own = ownRange(host, author);
        if (own && own[0] <= at && at <= own[1]) return rewriteOwn(full, host, author, at, at, text);
        const spot = spotInMark(full, host, at, author);
        if (typeof spot !== "number") {
          const ins = makeCritic.ins(text, author);
          return {
            ok: true,
            next: full.slice(0, host.start) + spot[0] + ins + spot[1] + full.slice(host.end),
            caret: host.start + spot[0].length + ins.length - 3,
          };
        }
        if (own && own[0] <= spot && spot <= own[1]) return rewriteOwn(full, host, author, spot, spot, text);
        p = spot;
      }
      // 紧贴自己插入的两端：接在那条上
      const before = segs.find((s) => s.end === p && ownRange(s, author));
      if (before) {
        const own = ownRange(before, author)!;
        return rewriteOwn(full, before, author, own[1], own[1], text);
      }
      const after = segs.find((s) => s.start === p && ownRange(s, author));
      if (after) {
        const own = ownRange(after, author)!;
        return rewriteOwn(full, after, author, own[0], own[0], text);
      }
      const ins = makeCritic.ins(text, author);
      return { ok: true, next: full.slice(0, p) + ins + full.slice(p), caret: p + ins.length - 3 };
    }

    const host = inside(at);
    if (host && host === inside(end)) {
      const own = ownRange(host, author);
      if (own && own[0] <= at && end <= own[1]) return rewriteOwn(full, host, author, at, end, text);
    }
    const guard = rangeGuard(full, at, end, op.rendered, overlapping);
    if (guard) return guard;
    const sub = makeCritic.sub(full.slice(at, end), text, author);
    return { ok: true, next: full.slice(0, at) + sub + full.slice(end), caret: at + sub.length - 3 };
  }

  // ---- 删除 ----
  if (op.at !== op.end) {
    const { at, end } = op;
    if (inCode(code, at, end)) return { ok: false, error: "代码围栏/行内代码里的标记是字面量，不支持在此修订" };
    const host = inside(at);
    if (host && host === inside(end)) {
      const own = ownRange(host, author);
      if (own && own[0] <= at && end <= own[1]) return rewriteOwn(full, host, author, at, end, "");
    }
    const guard = rangeGuard(full, at, end, op.rendered, overlapping);
    if (guard) return guard;
    const del = makeCritic.del(full.slice(at, end), author);
    return { ok: true, next: full.slice(0, at) + del + full.slice(end), caret: at };
  }

  // 单字删除：先跳过紧挨着的删除标记与批注（它们已经不算正文），再看落在哪里
  let p = op.at;
  const back = op.dir === "back";
  for (;;) {
    const host = inside(p);
    if (host) {
      const own = ownRange(host, author);
      if (own && own[0] <= p && p <= own[1]) {
        if (back ? p === own[0] : p === own[1]) {
          // 在自己插入的边上往外删：越过这条标记继续
          p = back ? host.start : host.end;
          continue;
        }
        const [a, b] = back ? [prevChar(full, p), p] : [p, nextChar(full, p)];
        return rewriteOwn(full, host, author, a, b, "");
      }
      return { ok: false, error: "这里是别人的建议或批注——先接受/拒绝它" };
    }
    const adj = segs.find((s) => (back ? s.end === p : s.start === p));
    if (!adj) break;
    const own = ownRange(adj, author);
    if (own) {
      // 自己插入紧挨着：删的是它的末字（或首字）
      if (own[0] === own[1]) {
        p = back ? adj.start : adj.end;
        continue;
      }
      const [a, b] = back ? [prevChar(full, own[1]), own[1]] : [own[0], nextChar(full, own[0])];
      return rewriteOwn(full, adj, author, a, b, "");
    }
    if (adj.kind === "del" || adj.kind === "comment") {
      p = back ? adj.start : adj.end;
      continue;
    }
    return { ok: false, error: "这里是别人的建议或批注——先接受/拒绝它" };
  }

  const [a, b] = back ? [prevChar(full, p), p] : [p, nextChar(full, p)];
  if (a === b) return { ok: false, error: "已经到头了" };
  const ch = full.slice(a, b);
  if (/\r|\n/.test(ch)) return { ok: false, error: "审阅模式暂不支持合并段落——切到编辑模式处理" };
  if (inCode(code, a, b)) return { ok: false, error: "代码围栏/行内代码里的标记是字面量，不支持在此修订" };
  if (/[*_`~\[\]()<>#|\\]/.test(ch)) return { ok: false, error: "这里是格式符号，审阅模式不改格式——切到编辑模式处理" };

  // 并进紧邻的自己那条删除
  const mine = segs.find((s) => s.kind === "del" && s.author === author && (back ? s.start === b : s.end === a));
  if (mine) {
    const del = makeCritic.del(back ? ch + mine.text : mine.text + ch, author);
    const from = back ? a : mine.start;
    const to = back ? mine.end : b;
    return { ok: true, next: full.slice(0, from) + del + full.slice(to), caret: back ? a : from + del.length };
  }
  const del = makeCritic.del(ch, author);
  return { ok: true, next: full.slice(0, a) + del + full.slice(b), caret: back ? a : a + del.length };
}

/** 各段按源码顺序排好，首尾相接（或重叠）的并成一组 */
function groupsOf(pieces: Array<{ a: number; b: number }>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of [...pieces].sort((x, y) => x.a - y.a)) {
    const last = out[out.length - 1];
    if (last && p.a <= last[1]) last[1] = Math.max(last[1], p.b);
    else if (p.b > p.a) out.push([p.a, p.b]);
  }
  return out;
}

type Splice = { from: number; to: number; repl: string; caret: number };

/** 从后往前拼；光标取最靠前那一处（它前面的偏移不受后面的拼接影响） */
function applySplices(full: string, splices: Splice[]): EditResult {
  if (!splices.length) return { ok: false, error: "选中的字已经标了删除" };
  const sorted = [...splices].sort((x, y) => y.from - x.from);
  let next = full;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].to > sorted[i - 1].from) return { ok: false, error: "选区与已有审阅标记重叠——先接受/拒绝该标记" };
    next = next.slice(0, sorted[i].from) + sorted[i].repl + next.slice(sorted[i].to);
  }
  const first = sorted[sorted.length - 1];
  return { ok: true, next, caret: first.from + first.caret };
}

/**
 * 审阅模式删除 / 替换页面上的字：每组各包一条删除（第一组带上新文字就成替换）。
 * 组落在自己的插入里 = 直接改它；落在已标删除的字里 = 跳过；碰到别人的建议、批注 = 不动手。
 */
function planPieces(full: string, op: Extract<EditOp, { kind: "pieces" }>, author: string): EditResult {
  const { text, dir } = op;
  if (DELIM.test(text)) return { ok: false, error: "内容包含标记定界符（如 ~>、--}），会写坏标记语法——换个措辞" };
  const groups = groupsOf(op.pieces);
  if (!groups.length) return { ok: false, error: "已经到头了" };
  const segs = parseCritic(full);
  const code = codeRanges(full);
  const used = new Set<CriticSegment>();
  const splices: Splice[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const [a, b] = groups[gi];
    const put = gi === 0 ? text : "";
    if (inCode(code, a, b)) return { ok: false, error: "代码围栏/行内代码里的标记是字面量，不支持在此修订" };
    const hit = segs.find((s) => a < s.end && b > s.start);
    if (hit) {
      const own = ownRange(hit, author);
      if (own && own[0] <= a && b <= own[1]) {
        used.add(hit);
        const content = full.slice(own[0], a) + put + full.slice(b, own[1]);
        if (content === "") {
          const repl = hit.kind === "sub" ? makeCritic.del(hit.old ?? "", author) : "";
          splices.push({ from: hit.start, to: hit.end, repl, caret: 0 });
        } else splices.push({ from: a, to: b, repl: put, caret: put.length });
        continue;
      }
      const r = contentRange(hit);
      const gone = hit.kind === "del" ? [r.cs, r.ce] : hit.kind === "sub" ? r.old! : null;
      if (gone && gone[0] <= a && b <= gone[1]) {
        // 已经标了删除：不再删；要换成新字就接在这条标记后面插入
        used.add(hit);
        if (put) {
          const ins = makeCritic.ins(put, author);
          splices.push({ from: hit.end, to: hit.end, repl: ins, caret: ins.length - 3 });
        }
        continue;
      }
      return { ok: false, error: "选区与别人的建议或批注重叠——先接受/拒绝它" };
    }
    if (put) {
      const sub = makeCritic.sub(full.slice(a, b), put, author);
      splices.push({ from: a, to: b, repl: sub, caret: sub.length - 3 });
      continue;
    }
    // 并进紧邻的自己那条删除（连续退格、向前删）
    const mine = segs.find((s) => !used.has(s) && s.kind === "del" && s.author === author && (s.end === a || s.start === b));
    if (mine) used.add(mine);
    const from = mine ? Math.min(mine.start, a) : a;
    const to = mine ? Math.max(mine.end, b) : b;
    const del = makeCritic.del(mine ? (mine.end === a ? mine.text + full.slice(a, b) : full.slice(a, b) + mine.text) : full.slice(a, b), author);
    splices.push({ from, to, repl: del, caret: dir === "back" ? 0 : del.length });
  }
  return applySplices(full, splices);
}

/** 选区操作的护栏：不跨标记、不跨空行、不吞格式符号（渲染文字须逐字等于源码） */
function rangeGuard(
  full: string,
  at: number,
  end: number,
  rendered: string | undefined,
  overlapping: (a: number, b: number) => CriticSegment | undefined,
): EditResult | null {
  if (overlapping(at, end)) return { ok: false, error: "选区与已有审阅标记重叠——先接受/拒绝该标记" };
  const old = full.slice(at, end);
  if (/\r?\n[ \t]*\r?\n/.test(old)) return { ok: false, error: "选区跨了段落——缩小到一段之内" };
  if (rendered !== undefined && rendered.replace(/\r?\n/g, "\n") !== old.replace(/\r?\n/g, "\n")) {
    return { ok: false, error: "选中的文字带格式（加粗/链接等），无法直接修订——缩小选择到纯文本，或切到编辑模式处理" };
  }
  return null;
}

function prevChar(s: string, p: number): number {
  if (p <= 0) return 0;
  const c = s.charCodeAt(p - 1);
  return c >= 0xdc00 && c <= 0xdfff && p >= 2 ? p - 2 : p - 1;
}

function nextChar(s: string, p: number): number {
  if (p >= s.length) return s.length;
  const c = s.charCodeAt(p);
  return c >= 0xd800 && c <= 0xdbff && p + 1 < s.length ? p + 2 : p + 1;
}
