import { describe, expect, it } from "vitest";
import { analyzeReview, transformChunk } from "./review-transform";

const transform = (text: string) => transformChunk(text, 0, analyzeReview(text));
describe("审阅渲染的代码保护", () => {
  it.each([
    "`【行内】`", "``【含`反引号】``", "    【缩进代码】", "\t【制表代码】",
    "````md\n```\n【长围栏内】\n```\n````", "> ```\n> 【引用内代码】\n> ```",
  ])("代码字节不被改成 HTML：%s", (source) => { expect(transform(source)).toBe(source); });

  it("使用原文位置，前方建议扩展成 HTML 不影响后方代码保护", () => {
    const source = "{++新增++} `【代码】` 正文【<img src=x>】";
    const out = transform(source);
    expect(out).toContain("`【代码】`");
    expect(out).toContain('class="agent-note" data-cr="18,31">【&lt;img src=x&gt;】</span>');
    expect(out.match(/class="agent-note"/g)).toHaveLength(1);
  });

  it("不会在审阅标记内容里二次插入 agent-note HTML", () => {
    const out = transform("{++【建议里的话】++} 【正文的话】");
    expect(out.match(/class="agent-note"/g)).toHaveLength(1);
    expect(out).toContain(">【建议里的话】</ins>");
  });
});

describe("含换行的标记按行拆开", () => {
  const lines = (s: string) => s.split("\n").length;
  const cr = (out: string) => [...out.matchAll(/data-cr="(\d+),(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);

  it("单行标记的输出不变", () => {
    expect(transform("甲{++乙++}丙")).toBe('甲<ins class="cm-ins" data-cmid="0">乙</ins>丙');
  });

  it("段落中间的回车：一个 ¶ 加一个空元素，两段都不露标记", () => {
    const src = "甲{++@me: \n\n++}乙";
    const out = transform(src);
    expect(out).not.toContain("{++");
    expect(out).not.toContain("++}");
    expect(lines(out)).toBe(lines(src));
    expect(out).toMatch(/甲<ins class="cm-ins cm-break"[^>]*><\/ins>\n\n<ins class="cm-ins"[^>]*><\/ins>乙/);
  });

  it("多段插入：每段一个元素，区间对得上源码", () => {
    const src = "{++@claude: 段一\n\n段二++}后";
    const out = transform(src);
    expect(out).toMatch(/>段一<\/ins>\n\n<ins [^>]*>段二<\/ins>后/);
    expect(cr(out).map(([a, b]) => src.slice(a, b))).toEqual(["段一", "段二"]);
    expect(out.match(/data-cmid="0"/g)).toHaveLength(2);
  });

  it("段尾回车、后面没字：新空段落带 cm-anchor", () => {
    const out = transform("甲{++@me: \n\n++}\n\n乙");
    expect(out).toMatch(/<ins class="cm-ins cm-anchor"[^>]*><\/ins>\n\n乙/);
  });

  it("列表项与引用的前缀留在外面", () => {
    const list = transform("- 一{++@me: \n- 新++}\n- 二");
    expect(list).toMatch(/\n- <ins [^>]*>新<\/ins>\n- 二/);
    const quote = transform("> 一{++@me: \n>\n> 新++}");
    expect(quote).toMatch(/\n>\n> <ins [^>]*>新<\/ins>$/);
  });

  it("替换：旧文、新文各按行拆", () => {
    const out = transform("{~~@me: 旧~>新\n\n段~~}");
    expect(out).toMatch(/<del class="cm-del cm-sub"[^>]*>旧<\/del><ins class="cm-ins cm-sub cm-break"[^>]*>新<\/ins>\n\n<ins class="cm-ins cm-sub"[^>]*>段<\/ins>/);
  });

  it("删除的换行（合并段落）", () => {
    const out = transform("甲{--@me: \n\n--}乙");
    expect(out).toMatch(/甲<del class="cm-del cm-break"[^>]*><\/del>\n\n<del class="cm-del"[^>]*><\/del>乙/);
  });

  it("CRLF：换行原样留着", () => {
    const src = "{++@me: 一\r\n\r\n二++}";
    const out = transform(src);
    expect(out).toMatch(/>一<\/ins>\r\n\r\n<ins [^>]*>二<\/ins>/);
    expect(cr(out).map(([a, b]) => src.slice(a, b))).toEqual(["一", "二"]);
  });

  it("被分块切开：各块只出自己那几行", () => {
    const src = "{++@me: 一\n\n二++}";
    const segs = analyzeReview(src);
    const cut = src.indexOf("二");
    expect(transformChunk(src.slice(0, cut - 1), 0, segs)).toMatch(/>一<\/ins>\n$/);
    expect(transformChunk(src.slice(cut), cut, segs)).toMatch(/^<ins [^>]*>二<\/ins>$/);
  });

  it("含空行的批注仍按字面量", () => {
    const src = "{>>一\n\n二<<}";
    expect(transform(src)).toBe(src);
  });
});
