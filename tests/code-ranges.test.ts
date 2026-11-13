// @vitest-environment node
/**
 * 代码区判断只有一份（protocol 的 codeRanges，零依赖）。这里拿 mdast（渲染端用的 CommonMark 解析器）做差分：
 * 每个非空白字符「在不在代码里」两边必须一致。固定用例 + 定种子的随机拼装。
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { describe, expect, it } from "vitest";
import { applyAll, codeRanges, parseCritic } from "@openfile/protocol/criticmarkup";

function mdastMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(false);
  const visit = (n: Nodes) => {
    if (n.type === "code" || n.type === "inlineCode") {
      const s = n.position?.start.offset ?? 0;
      const e = n.position?.end.offset ?? 0;
      for (let i = s; i < e; i++) mask[i] = true;
    } else if ("children" in n) n.children.forEach(visit);
  };
  visit(fromMarkdown(src));
  return mask;
}

function ourMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(false);
  for (const [s, e] of codeRanges(src)) for (let i = s; i < e; i++) mask[i] = true;
  return mask;
}

/** 两边不一致的非空白字符位置；空 = 一致 */
function diff(src: string): number[] {
  const a = mdastMask(src);
  const b = ourMask(src);
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) if (!/\s/.test(src[i]) && a[i] !== b[i]) out.push(i);
  return out;
}

const CASES = [
  "a `x` b\n```\ncode {++x++}\n```\nc",
  "    {++缩进代码++}\n\n正文{++真++}",
  "> ```\n> {++引用里的围栏++}\n> ```\n\n{++外面++}",
  "- 列表\n\n  ```\n  {++列表里的围栏++}\n  ```\n- 下一项 {++真++}",
  "````\n```\n{++四反引号里的三反引号++}\n```\n````\n{++外++}",
  "段落 `跨\n行的代码 {++x++}` 结束",
  "\\`不是代码 {++真++}\\`",
  "1. 项\n\n       {++列表里的缩进代码++}\n",
  "> 引用\n懒延续 `代码` {++真++}",
  "```js\n未闭合 {++x++}\n",
  "> ```\n> 容器结束时围栏也结束\n\n{++外面++}",
  "# 标题 `{++x++}`\n\n---\n\n`` 双反引号 ` 里面 ``",
  "段落\n    不是缩进代码 {++真++}",
  "~~~\n{--波浪围栏--}\n~~~",
  "- a\n- b\n\n      code\n",
  "\r\n```\r\n{++CRLF 围栏++}\r\n```\r\n正文 `x`\r\n",
];

describe("codeRanges 与 mdast 一致", () => {
  it.each(CASES.map((c) => [JSON.stringify(c), c]))("%s", (_name, src) => {
    expect(diff(src)).toEqual([]);
  });

  // 已知的少数分歧（3000 份里 5 份，约 0.15%）都是 micromark 的懒行细节：引用块里的空列表项后面跟缩进行、
  // 缩进代码后面跟「2)」起头的有序列表。数只许降：改实现让它变多就是回归
  it("随机拼装 3000 份", () => {
    let seed = 20261018;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const prefixes = ["", "", "", "> ", ">", "- ", "1. ", "2) ", "  ", "    ", "   ", "> - ", "- > ", "      ", "\t", "-\t", ">\t"];
    const bodies = ["text {++x++}", "`code`", "``a ` b``", "```", "````", "~~~", "```js", "", "", "---", "***", "# h `c`", "a `open", "close` b", "\\`x\\`", "{--d--} `` x", "- item", "=="];
    const bad: string[] = [];
    for (let k = 0; k < 3000; k++) {
      const lines: string[] = [];
      const n = 1 + rnd(8);
      for (let j = 0; j < n; j++) lines.push(prefixes[rnd(prefixes.length)] + bodies[rnd(bodies.length)]);
      const src = lines.join("\n");
      if (diff(src).length > 0) bad.push(src);
    }
    expect(bad.length).toBeLessThanOrEqual(5);
  });
});

describe("代码里的标记不参与审阅", () => {
  it("applyAll 不改缩进代码、引用块与列表里的围栏", () => {
    const src = "    {++a++}\n\n> ```\n> {--b--}\n> ```\n\n- x\n\n  ```\n  {~~c~>d~~}\n  ```\n\n真的{++e++}";
    expect(parseCritic(src)).toHaveLength(1);
    expect(applyAll(src, true)).toBe(src.replace("{++e++}", "e"));
  });
});
