import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { parseCritic } from "@openfile/protocol/criticmarkup";
import { chunkPipeline } from "./markdown-pipeline";
import { decodeString } from "micromark-util-decode-string";
import { alignText, sourceSegments } from "./remark-source-map";
import { domPointToSource } from "./source-offsets";

/** 按界面同一条插件链渲染（整篇当一块） */
function render(src: string, review = true, swapBreaks = false) {
  const p = chunkPipeline(src, 0, parseCritic(src), review);
  const remarkPlugins = swapBreaks ? [...p.remarkPlugins.slice(0, -1), remarkBreaks] : p.remarkPlugins;
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins, rehypePlugins: p.rehypePlugins } as never, p.text));
}

function dom(src: string, review = true): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = render(src, review);
  return el;
}

/** 原样段（逐字等于源码）；atomic() 取转义、字符引用那种整个记号算一个字的段 */
function spans(src: string) {
  return [...dom(src).querySelectorAll("span[data-o]:not([data-oe])")].map((s) => ({ o: Number(s.getAttribute("data-o")), text: s.textContent! }));
}

function atomic(src: string) {
  return [...dom(src).querySelectorAll("span[data-oe]")].map((s) => ({ o: Number(s.getAttribute("data-o")), oe: Number(s.getAttribute("data-oe")), text: s.textContent! }));
}

/** 同类替换：汉字换汉字、字母换字母、数字换数字——不改变 CommonMark 判定分隔符时看的字符类别 */
function swap(ch: string): string | null {
  if (/\p{Script=Han}/u.test(ch)) return ch === "丁" ? "七" : "丁";
  if (/[a-z]/.test(ch)) return ch === "q" ? "z" : "q";
  if (/[A-Z]/.test(ch)) return ch === "Q" ? "Z" : "Q";
  if (/[0-9]/.test(ch)) return ch === "7" ? "8" : "7";
  return null;
}

/**
 * 对照：不看映射怎么算的，只看结果——把每个可修订的字在源码里那一位换成同类字、重新渲染，
 * 页面上恰好是这个位置的字变了、别处一个没变，映射才算对（重复字配错位置会在这里露馅）。
 */
function probe(src: string): number {
  const el = dom(src);
  const before = el.textContent!;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  let checked = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const span = n.parentElement;
    if (span?.matches(".cm-comment, .agent-note")) {
      // 气泡整个算一个落点，不能改字，也不和源码逐字相同
    } else if (span?.hasAttribute("data-oe")) {
      // 原子段：源码那一段解码后正是这个字
      expect(decodeString(src.slice(Number(span.getAttribute("data-o")), Number(span.getAttribute("data-oe")))), "原子段").toBe(n.data);
    } else if (span?.hasAttribute("data-o")) {
      const o = Number(span.getAttribute("data-o"));
      for (let k = 0; k < n.data.length; k++) {
        const ch = n.data[k];
        expect(src[o + k], `「${ch}」应在源码 ${o + k}`).toBe(ch);
        const rep = swap(ch);
        if (!rep) continue;
        const after = dom(src.slice(0, o + k) + rep + src.slice(o + k + 1)).textContent!;
        expect(after, `改源码 ${o + k} 的「${ch}」`).toBe(before.slice(0, at + k) + rep + before.slice(at + k + 1));
        checked++;
      }
    }
    at += n.data.length;
  }
  return checked;
}

/** 各种写法：显示与源码不逐字相同的、插件会改写节点的、容易错位的 */
const CORPUS: Record<string, string> = {
  转义与引用: "# 标题 \\* 与 &amp; 引用\n\na &lt; b 与 \\*星号\\* 和 &#x4F60;好 &#20320;们 &copy; 版权。\n",
  中文加粗后的引用: "1. **你的细纲交给模型。**&#x4F60;亲手写的细纲原样传给写作模型。\n",
  列表续行: "- 列表项一行\n  续行缩进的第二行\n- 第二项\n\n1. 有序一\n   有序续行\n",
  引用续行: "> 引用一\n> 引用二\n>\n> - 引用里的列表\n>   列表续行\n",
  软换行与行尾空格: "第一行 \n第二行\n   缩进的第三行\n",
  硬换行: "第一行\\\n第二行  \n**第三行**\n",
  重复字: "哈哈\n哈哈哈\n\n哈**哈哈**哈 哈*哈*哈\n",
  表格: "| 表头 | a\\|b |\n|---|---|\n| 单元 | www.example.com 与 https://x.org/p |\n",
  自动链接: "见 <https://example.com/a> 和 www.abc.com 以及 me@abc.com 结束\n",
  中文标点后的网址: "联系方式：hello\\@example.com\n\n- 官网：https\\://example.com\n- 文档：https://docs.example.org/a，见上\n\n请写信到 me@abc.com。谢谢\n",
  脚注: "正文有脚注[^1]，接着写。\n\n[^1]: 脚注内容在这里\n",
  HTML: "前文 <span>行内 HTML 文字</span> 后文\n\n<div>\n块内 HTML 文字\n</div>\n",
  公式: "质能 $E=mc^2$ 方程\n\n$$\nx^2\n$$\n",
  任务列表: "- [ ] 待办 事项\n- [x] 已完成 事项\n",
  删除线与强调: "~~删掉的~~ 与 *斜体* 和 foo_bar_baz 以及 **粗体**\n",
  链接与图片: "看 [链接文字](x.md) 和 ![图片说明](a.png) 尾巴\n",
  审阅标记: "本研究采用{~~@bob: 定性~>混合~~}方法{++新增++}，{--删掉--}{==高亮==}{>>@bob: 批注<<}。【给 agent 的话】\n",
  含换行的修订: "甲{++@me: \n\n新段++}乙\n\n丙{--@me: 旧\n\n文--}丁\n\n- 项{++@me: \n- 新项++}\n- 二\n\n> 引{++@me: \n>\n> 新++}\n\n段尾{++@me: \n\n++}\n\n软{++@me: \n行++}换\n\n{~~@me: 旧~>新\n\n字~~}\n\n收尾\n",
  代码: "行内 `code` 和\n\n```js\nlet a = 1;\n```\n\n尾巴\n",
  制表符: "- 列表\n\t制表符续行\n\n>\t引用里的制表符\n",
  CRLF: "第一行\r\n第二行\r\n\r\n- 项目\r\n  续行\r\n",
  BOM: "﻿开头带 BOM\n\n哈哈哈\n",
};

describe("逐字源码映射", () => {
  it("语料里每个可修订的字都对得上：逐字等于源码，改源码那一位只改页面上那一个字", () => {
    let total = 0;
    for (const [name, src] of Object.entries(CORPUS)) {
      const n = probe(src);
      expect(n, `${name} 至少有可修订的字`).toBeGreaterThan(0);
      total += n;
    }
    expect(total).toBeGreaterThan(300);
  });

  it("列表与引用的续行、软换行后的行都能修订（remark-breaks 拆出的节点没有位置）", () => {
    const texts = (src: string) => spans(src).map((s) => s.text);
    expect(texts(CORPUS.列表续行)).toEqual(expect.arrayContaining(["列表项一行", "续行缩进的第二行", "有序一", "有序续行"]));
    expect(texts(CORPUS.引用续行)).toEqual(expect.arrayContaining(["引用一", "引用二", "引用里的列表", "列表续行"]));
    expect(texts(CORPUS.软换行与行尾空格)).toEqual(expect.arrayContaining(["第一行", "第二行", "缩进的第三行"]));
    expect(spans("哈哈\n哈哈哈\n")).toEqual([{ o: 0, text: "哈哈" }, { o: 3, text: "哈哈哈" }]);
  });

  it("中文标点紧挨的网址、邮箱（建树后才认出、节点没位置）照常能修订", () => {
    const texts = spans(CORPUS.中文标点后的网址).map((s) => s.text);
    expect(texts).toEqual(expect.arrayContaining(["联系方式：", "hello", "example.com", "官网：", "https", "//example.com", "文档：", "https://docs.example.org/a，见上", "请写信到 ", "me@abc.com", "。谢谢"]));
  });

  it("转义、字符引用出来的字单独成段，记下整个记号的起止；同一段里其余文字照常逐字对上", () => {
    const src = CORPUS.转义与引用;
    const got = spans(src).map((s) => s.text);
    expect(got.some((t) => /[&*<你©]/.test(t))).toBe(false);
    expect(got).toEqual(expect.arrayContaining(["星号", "好 ", "们 ", " 版权。"]));
    const atoms = atomic(src);
    expect(atoms.map((x) => x.text)).toEqual(["*", "&", "<", "*", "*", "你", "你", "©"]);
    for (const x of atoms) expect(decodeString(src.slice(x.o, x.oe))).toBe(x.text);
    expect(atoms.find((x) => x.text === "©")).toMatchObject({ o: src.indexOf("&copy;"), oe: src.indexOf("&copy;") + 6 });
  });

  it("BOM 文件不错位（解析器跳过 BOM 却不计偏移）", () => {
    for (const s of spans(CORPUS.BOM)) expect(CORPUS.BOM.slice(s.o, s.o + s.text.length)).toBe(s.text);
    expect(spans(CORPUS.BOM).map((s) => s.o)).toContain(CORPUS.BOM.indexOf("哈哈哈"));
  });

  it("代码、公式、批注气泡、给 agent 的话、脚注编号不可修订", () => {
    const all = Object.values(CORPUS).flatMap((src) => spans(src).map((s) => s.text));
    for (const no of ["code", "let a = 1;", "说明依据", "批注", "给 agent 的话", "E=mc^2"]) expect(all.join("|")).not.toContain(no);
    // 审阅标记内文照常能改
    expect(spans(CORPUS.审阅标记).map((s) => s.text)).toEqual(expect.arrayContaining(["定性", "混合", "新增", "删掉", "高亮"]));
  });

  it("光标在转义出来的字两端：前端 = 记号起点，后端 = 记号终点", () => {
    const src = CORPUS.中文加粗后的引用;
    const el = dom(src);
    const entity = (el.querySelector("strong")!.nextSibling as HTMLElement).firstChild as Text;
    expect(entity.data).toBe("你");
    expect(domPointToSource(entity, 0)).toBe(src.indexOf("&#x4F60;"));
    expect(domPointToSource(entity, 1)).toBe(src.indexOf("亲手"));
  });

  it("软换行输出与 remark-breaks 逐字相同；审阅与阅读显示的文字相同", () => {
    for (const [name, src] of Object.entries(CORPUS)) {
      expect(render(src, false), name).toBe(render(src, false, true));
      expect(dom(src, true).textContent, name).toBe(dom(src, false).textContent);
    }
  });

  it("对齐：段拼不满节点的值就整段不映射", () => {
    const segs = sourceSegments("a &amp; b", []);
    expect(alignText("a & b", 0, 9, segs)?.map((r) => [r.from, r.to, r.s, r.atomic])).toEqual([[0, 2, 0, false], [2, 3, 2, true], [3, 5, 7, false]]);
    expect(alignText("a ? b", 0, 9, segs)).toBeNull();
    expect(alignText("a & b!", 0, 9, segs)).toBeNull();
  });

  it("一万字的块：审阅模式渲染不出现量级上的变慢", () => {
    const line = "这是一段用来测性能的文字，带 **加粗** 与 *斜体*、&amp; 引用和 \\* 转义，还有{++插入++}和续行\n  第二行。\n\n";
    const src = line.repeat(Math.ceil(10000 / line.length));
    render(src, false);
    const t0 = performance.now();
    render(src, false);
    const read = performance.now() - t0;
    const t1 = performance.now();
    render(src, true);
    const review = performance.now() - t1;
    console.info(`一万字块：阅读 ${read.toFixed(1)}ms，审阅 ${review.toFixed(1)}ms`);
    expect(review).toBeLessThan(Math.max(read * 4, 300));
  });
});
