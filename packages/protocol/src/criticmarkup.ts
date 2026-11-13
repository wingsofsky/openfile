/**
 * 审阅内核：CriticMarkup 解析 / 应用 / 统计。
 *
 * 格式主权契约（CONTRIBUTING.md 不变量 3）：审阅状态全部内嵌纯文本，
 * 任何编辑器 / agent / `cat` 都能读写。语法（CriticMarkup 标准 + 作者扩展）：
 *
 *   {++插入++}   {--删除--}   {~~旧~>新~~}   {>>批注<<}   {==高亮==}
 *   作者扩展：内容以 `@名字:` 开头 ⇒ 记为该作者（如 {++@claude: 新句++}）
 *   给 agent 的话：【…】（非 CriticMarkup，仅渲染高亮，不参与接受/拒绝）
 *
 * 代码（围栏、缩进代码、行内代码，含引用块与列表里的，见 codeRanges）中的标记视为字面量，
 * 绝不解析——agent 的文档里满是语法示例。
 */

export type MarkKind = "ins" | "del" | "sub" | "comment" | "mark";

export interface CriticSegment {
  kind: MarkKind;
  /** 含花括号的完整源区间 [start, end) */
  start: number;
  end: number;
  /** 内文（不含作者前缀） */
  text: string;
  /** sub 专用 */
  old?: string;
  newText?: string;
  author?: string;
}

const OPENERS: Array<{ open: string; close: string; kind: MarkKind }> = [
  { open: "{++", close: "++}", kind: "ins" },
  { open: "{--", close: "--}", kind: "del" },
  { open: "{~~", close: "~~}", kind: "sub" },
  { open: "{>>", close: "<<}", kind: "comment" },
  { open: "{==", close: "==}", kind: "mark" },
];

const AUTHOR_RE = /^@([^\s:：]{1,32})[:：]\s?/;

/**
 * 哪里是代码：围栏代码、缩进代码与行内代码的源区间 [start,end)，按起点排序。
 * 全仓唯一一份判断（审阅解析、渲染、MCP、记忆日志都用它）。按 CommonMark 的块结构走：
 * 引用块（`>`）与列表项里的围栏 / 缩进代码也算，行内代码可以跨段落内的换行；
 * 没有闭合的围栏到所在容器结束（或文末）为止。制表符按 4 列的制表位展开后再判断。
 * 以渲染端用的 mdast（micromark）为准，tests/code-ranges.test.ts 做差分钉住。不处理：HTML 块。
 */
export function codeRanges(src: string): Array<[number, number]> {
  /** 列表项：empty = 起头一行没内容；空着又遇到空行就结束（CommonMark：至多以一个空行开头） */
  type Container = { kind: "bq" } | { kind: "li"; indent: number; empty: boolean; dead?: boolean };
  type Leaf =
    | { kind: "para"; parts: Array<[number, number]> }
    | { kind: "fence"; ch: string; len: number; start: number; end: number }
    | { kind: "indented"; start: number; end: number };
  const ranges: Array<[number, number]> = [];
  const stack: Container[] = [];
  let leaf: Leaf | null = null;
  let prevLineEnd = 0;

  const spaces = (s: string) => /^ */.exec(s)![0].length;
  const blank = (s: string) => /^ *$/.test(s);
  const fenceOpen = (s: string) => {
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(s);
    if (!m || (m[2][0] === "`" && m[3].includes("`"))) return null;
    return { ch: m[2][0], len: m[2].length, ind: m[1].length };
  };
  const thematic = (s: string) => /^ {0,3}([-*_])(?: *\1){2,} *$/.test(s);
  const atx = (s: string) => /^ {0,3}#{1,6}(?: |$)/.test(s);
  const closeLeaf = () => {
    if (leaf?.kind === "fence" || leaf?.kind === "indented") ranges.push([leaf.start, leaf.end]);
    else if (leaf?.kind === "para") inlineCode(src, leaf.parts, ranges);
    leaf = null;
  };

  for (let ls = 0; ls <= src.length; ) {
    const nl = src.indexOf("\n", ls);
    const raw = src.slice(ls, nl === -1 ? src.length : nl).replace(/\r$/, "");
    const lineEnd = ls + raw.length;
    // 制表符展开成空格；at[i] = 展开后第 i 个字符在原文里的位置
    let line = "";
    const at: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const w = raw[i] === "\t" ? 4 - (line.length % 4) : 1;
      for (let k = 0; k < w; k++) at.push(ls + i);
      line += raw[i] === "\t" ? " ".repeat(w) : raw[i];
    }
    at.push(lineEnd);
    const next = () => {
      prevLineEnd = lineEnd;
      return nl === -1 ? src.length + 1 : nl + 1;
    };

    // 1. 已打开的容器逐个对上
    let pos = 0;
    let matched = 0;
    for (const c of stack) {
      if (c.kind === "bq") {
        const ws = spaces(line.slice(pos));
        if (ws > 3 || line[pos + ws] !== ">") break;
        pos += ws + 1;
        if (line[pos] === " ") pos++;
      } else if (blank(line.slice(pos))) {
        if (c.empty) c.dead = true;
      } else {
        if (c.dead || spaces(line.slice(pos)) < c.indent) break;
        pos += c.indent;
        c.empty = false;
      }
      matched++;
    }
    const all = matched === stack.length;
    let rest = line.slice(pos);
    const prev = leaf === null ? null : (leaf as Leaf).kind;

    // 2. 代码块延续
    if (leaf?.kind === "fence") {
      if (all) {
        const m = /^ {0,3}(`{3,}|~{3,}) *$/.exec(rest);
        if (m && m[1][0] === leaf.ch && m[1].length >= leaf.len) {
          ranges.push([leaf.start, lineEnd]);
          leaf = null;
        } else if (rest.length > 0) leaf.end = lineEnd; // 只有空白的内容行也是代码
        ls = next();
        continue;
      }
      leaf.end = prevLineEnd; // 容器结束，围栏连同里面的空行一起结束
      closeLeaf();
    } else if (leaf?.kind === "indented") {
      if (all && (blank(rest) || spaces(rest) >= 4)) {
        if (!blank(rest)) leaf.end = lineEnd;
        ls = next();
        continue;
      }
      closeLeaf();
    }

    // 3. 新容器。紧跟段落（micromark 里紧跟缩进代码也一样）时，空列表项与非 1 起的有序列表不能开头
    const opened: Container[] = [];
    let interrupting = all && (prev === "para" || prev === "indented");
    for (;;) {
      const ws = spaces(rest);
      if (ws >= 4) break;
      if (rest[ws] === ">") {
        const k = ws + 1 + (rest[ws + 1] === " " ? 1 : 0);
        opened.push({ kind: "bq" });
        rest = rest.slice(k);
        pos += k;
        interrupting = false;
        continue;
      }
      if (thematic(rest)) break;
      const lm = /^ {0,3}(?:[-+*]|(\d{1,9})[.)])(?= |$)/.exec(rest);
      if (!lm) break;
      const after = rest.slice(lm[0].length);
      const emptyItem = blank(after);
      if (interrupting && (emptyItem || (lm[1] !== undefined && lm[1] !== "1"))) break;
      const n = spaces(after);
      const width = lm[0].length + (emptyItem || n >= 5 ? 1 : n);
      opened.push({ kind: "li", indent: width, empty: emptyItem });
      const take = Math.min(width, rest.length);
      rest = rest.slice(take);
      pos += take;
      interrupting = false;
    }

    // 4. 段落的懒延续：容器没对齐、也没开新块，正文接在上一段后面
    if (!all && opened.length === 0 && leaf?.kind === "para" && !blank(rest) && !fenceOpen(rest) && !thematic(rest) && !atx(rest)) {
      leaf.parts.push([at[pos], lineEnd]);
      ls = next();
      continue;
    }
    if (!all || opened.length > 0) {
      closeLeaf();
      stack.length = matched;
    }
    stack.push(...opened);

    // 5. 叶子块
    const start = at[pos];
    const f = fenceOpen(rest);
    if (blank(rest)) {
      closeLeaf();
    } else if (spaces(rest) >= 4 && leaf?.kind !== "para") {
      leaf = { kind: "indented", start, end: lineEnd };
    } else if (f) {
      closeLeaf();
      leaf = { kind: "fence", ch: f.ch, len: f.len, start: at[pos + f.ind], end: lineEnd };
    } else if (atx(rest)) {
      closeLeaf();
      inlineCode(src, [[start, lineEnd]], ranges);
    } else if (leaf?.kind === "para" && /^ {0,3}(?:=+|-+) *$/.test(rest)) {
      closeLeaf(); // setext 标题的下划线
    } else if (thematic(rest)) {
      closeLeaf();
    } else if (leaf?.kind === "para") {
      leaf.parts.push([start, lineEnd]);
    } else {
      leaf = { kind: "para", parts: [[start, lineEnd]] };
    }
    ls = next();
  }
  closeLeaf();
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** 段落（若干行片段）里的行内代码：等长反引号串成对；代码外的 \` 是字面反引号 */
function inlineCode(src: string, parts: Array<[number, number]>, out: Array<[number, number]>): void {
  // 把各行片段拼成一串，记下每个字符在原文里的位置
  const at: number[] = [];
  let text = "";
  parts.forEach(([s, e], k) => {
    if (k > 0) {
      text += "\n";
      at.push(s - 1);
    }
    for (let i = s; i < e; i++) at.push(i);
    text += src.slice(s, e);
  });
  const run = (i: number) => {
    let n = 0;
    while (text[i + n] === "`") n++;
    return n;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) {
      i += 2;
      continue;
    }
    if (ch !== "`") {
      i++;
      continue;
    }
    const n = run(i);
    let j = i + n;
    let close = -1;
    while (j < text.length) {
      if (text[j] === "`") {
        const m = run(j);
        if (m === n) {
          close = j;
          break;
        }
        j += m;
      } else j++;
    }
    if (close === -1) {
      i += n;
      continue;
    }
    out.push([at[i], at[close + n - 1] + 1]);
    i = close + n;
  }
}

/** pos 是否落在 codeRanges 的某个区间里 */
export function inRanges(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (pos >= s && pos < e) return true;
    if (s > pos) break;
  }
  return false;
}

/** 给 agent 的话：【…】，单行、不嵌套、至多 500 字（渲染、源码高亮、签发摘要、MCP 共用这一条） */
export const AGENT_NOTE_PATTERN = "【([^【】\\n]{1,500})】";

export interface AgentNote {
  start: number;
  end: number;
  text: string;
}

/** 代码区之外的【…】，按出现顺序；ranges 缺省现算 */
export function agentNotes(src: string, ranges: Array<[number, number]> = codeRanges(src)): AgentNote[] {
  const out: AgentNote[] = [];
  for (const m of src.matchAll(new RegExp(AGENT_NOTE_PATTERN, "g"))) {
    if (!inRanges(m.index, ranges)) out.push({ start: m.index, end: m.index + m[0].length, text: m[1] });
  }
  return out;
}

/** 解析全部审阅标记（跳过代码区），按出现顺序返回 */
export function parseCritic(src: string): CriticSegment[] {
  const masked = codeRanges(src);
  const out: CriticSegment[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "{") {
      i++;
      continue;
    }
    if (inRanges(i, masked)) {
      i++;
      continue;
    }
    const opener = OPENERS.find((o) => src.startsWith(o.open, i));
    if (!opener) {
      i++;
      continue;
    }
    const close = src.indexOf(opener.close, i + opener.open.length);
    if (close === -1) {
      i++;
      continue;
    }
    const end = close + opener.close.length;
    let inner = src.slice(i + opener.open.length, close);
    let author: string | undefined;
    const am = inner.match(AUTHOR_RE);
    if (am) {
      author = am[1];
      inner = inner.slice(am[0].length);
    }
    const seg: CriticSegment = {
      kind: opener.kind,
      start: i,
      end,
      text: inner,
      author,
    };
    if (opener.kind === "sub") {
      const arrow = inner.indexOf("~>");
      if (arrow === -1) {
        // 缺箭头的 {~~…~~} 不是合法替换，按字面量跳过
        i += opener.open.length;
        continue;
      }
      seg.old = inner.slice(0, arrow);
      seg.newText = inner.slice(arrow + 2);
    }
    out.push(seg);
    i = end;
  }
  return out;
}

/** 接受（true）或拒绝（false）单个标记，返回新源文本 */
export function applySegment(src: string, seg: CriticSegment, accept: boolean): string {
  let replacement: string;
  switch (seg.kind) {
    case "ins":
      replacement = accept ? seg.text : "";
      break;
    case "del":
      replacement = accept ? "" : seg.text;
      break;
    case "sub":
      replacement = accept ? (seg.newText ?? "") : (seg.old ?? "");
      break;
    case "comment":
      replacement = ""; // 解决批注 = 移除（accept/reject 同义）
      break;
    case "mark":
      replacement = seg.text; // 去掉高亮外壳，保留内文
      break;
  }
  return src.slice(0, seg.start) + replacement + src.slice(seg.end);
}

/** 全部接受 / 全部拒绝（批注一律移除，高亮一律去壳） */
export function applyAll(src: string, accept: boolean): string {
  // 从后往前替换，避免偏移失效
  const segs = parseCritic(src);
  let out = src;
  for (let i = segs.length - 1; i >= 0; i--) {
    out = applySegment(out, segs[i], accept);
  }
  return out;
}

export interface CriticCounts {
  ins: number;
  del: number;
  sub: number;
  comment: number;
  mark: number;
  total: number;
  /** 需要决策的建议数（不含高亮） */
  actionable: number;
}

export function countCritic(src: string): CriticCounts {
  const c = { ins: 0, del: 0, sub: 0, comment: 0, mark: 0 };
  for (const s of parseCritic(src)) c[s.kind]++;
  const total = c.ins + c.del + c.sub + c.comment + c.mark;
  return { ...c, total, actionable: c.ins + c.del + c.sub + c.comment };
}

/** 构造标记（编辑器工具条用） */
export const makeCritic = {
  ins: (text: string, author?: string) =>
    `{++${author ? `@${author}: ` : ""}${text}++}`,
  del: (text: string, author?: string) =>
    `{--${author ? `@${author}: ` : ""}${text}--}`,
  sub: (oldText: string, newText: string, author?: string) =>
    `{~~${author ? `@${author}: ` : ""}${oldText}~>${newText}~~}`,
  comment: (text: string, author?: string) =>
    `{>>${author ? `@${author}: ` : ""}${text}<<}`,
};
