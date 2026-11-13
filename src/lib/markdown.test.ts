import { describe, expect, it } from "vitest";
import { chunkMarkdown, extractToc, slugify } from "./markdown";

describe("extractToc", () => {
  it("提取标题与层级，行号为 1-based", () => {
    const src = "# 一\n\n正文\n\n## 二\n\n### 三";
    const toc = extractToc(src);
    expect(toc.map((t) => [t.level, t.text, t.line])).toEqual([
      [1, "一", 1],
      [2, "二", 5],
      [3, "三", 7],
    ]);
  });

  it("忽略代码围栏内的 # 行", () => {
    const src = "# 真标题\n```\n# 不是标题\n```\n~~~\n## 也不是\n~~~\n## 真二级";
    const toc = extractToc(src);
    expect(toc.map((t) => t.text)).toEqual(["真标题", "真二级"]);
  });

  it("四反引号围栏内的三反引号不误闭合（审查发现 #1）", () => {
    // 常见于展示 markdown 的 agent 文档：外层 4 反引号，内含 ``` 代码块
    const src = [
      "# 顶标题",
      "````",
      "```js",
      "# 这是代码里的井号，不是标题",
      "```",
      "````",
      "## 尾标题",
    ].join("\n");
    const toc = extractToc(src);
    // 只应有「顶标题」「尾标题」，绝不能出现代码里的井号行
    expect(toc.map((t) => t.text)).toEqual(["顶标题", "尾标题"]);
  });

  it("setext 标题进入 TOC（审查发现 #3）", () => {
    const src = "一级标题\n======\n\n正文\n\n二级标题\n------\n\n更多";
    const toc = extractToc(src);
    expect(toc.map((t) => [t.level, t.text])).toEqual([
      [1, "一级标题"],
      [2, "二级标题"],
    ]);
  });

  it("同名标题 id 去重", () => {
    const toc = extractToc("# 概述\n\n# 概述");
    expect(toc[0].id).not.toBe(toc[1].id);
  });

  it("中文标题产生可用 id", () => {
    const toc = extractToc("## 第三章 方法论");
    expect(toc[0].id.length).toBeGreaterThan(0);
    expect(toc[0].id).not.toMatch(/\s/);
  });
});

describe("slugify", () => {
  it("重复 slug 追加序号", () => {
    const used = new Map<string, number>();
    expect(slugify("Intro", used)).toBe("intro");
    expect(slugify("Intro", used)).toBe("intro-1");
    expect(slugify("Intro", used)).toBe("intro-2");
  });

  it("空内容兜底为 section", () => {
    const used = new Map<string, number>();
    expect(slugify("###", used)).toBe("section");
  });
});

describe("chunkMarkdown", () => {
  it("短文档不分块", () => {
    const src = "# a\n\nb\n";
    expect(chunkMarkdown(src)).toHaveLength(1);
  });

  it("分块后拼回原文（无损）", () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(`## 第${i}节`, "", "段落".repeat(30), "");
    }
    const src = lines.join("\n");
    const chunks = chunkMarkdown(src, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.src).join("\n")).toBe(src);
  });

  it("startLine 与源文本行号一致", () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(`## 第${i}节`, "", "内容", "");
    }
    const src = lines.join("\n");
    const chunks = chunkMarkdown(src, 10);
    for (const c of chunks) {
      const expected = src.split("\n")[c.startLine - 1];
      expect(c.src.split("\n")[0]).toBe(expected);
    }
  });

  it("不在代码围栏中间切块（含内部空行）", () => {
    const lines: string[] = ["# 头", "", "```"];
    for (let i = 0; i < 100; i++) {
      lines.push(`code line ${i}`);
      if (i % 10 === 0) lines.push(""); // 围栏内空行：正则扫描会误切，AST 不会
    }
    lines.push("```", "", "尾部");
    const src = lines.join("\n");
    const chunks = chunkMarkdown(src, 20);
    for (const c of chunks) {
      const fences = c.src.split("\n").filter((l) => l.trim() === "```").length;
      expect(fences % 2).toBe(0); // 围栏成对，未被切断
    }
  });

  it("缩进代码块（含内部空行）不被跨块切断（审查发现 #2）", () => {
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) lines.push(`段 ${i}。`, "");
    lines.push("正文引子：", "");
    for (let i = 0; i < 30; i++) {
      lines.push(`    code_${i}();`); // 4 空格缩进码
      if (i % 5 === 0) lines.push(""); // 内部空行
    }
    lines.push("", "结尾。");
    const src = lines.join("\n");
    const chunks = chunkMarkdown(src, 160);
    // 缩进码块不该以「续块起点是缩进行」的形式被切开
    const brokenIndent = chunks.slice(1).some((c) => /^ {4,}\S/.test(c.src.split("\n").find(Boolean) || ""));
    expect(brokenIndent).toBe(false);
    expect(chunks.map((c) => c.src).join("\n")).toBe(src);
  });

  // 关键回归：块级构造跨块会被 react-markdown 当成新构造（有序列表重启编号、
  // 引用/表格断成两截）。切点必须落在安全的块边界（下一行是标题或顶格文字）。
  const startsBlockContinuation = (chunk: { src: string }) => {
    const firstNonEmpty = chunk.src.split("\n").find((l) => l.trim() !== "") ?? "";
    return /^(\s*([-*+]|\d+[.)])\s|\s*>|\s{0,3}\|)/.test(firstNonEmpty);
  };

  it("松散有序列表不被跨块切断（否则第二块重启编号）", () => {
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) lines.push(`段 ${i}。`, "");
    for (let i = 1; i <= 20; i++) lines.push(`${i}. 第 ${i} 项`, ""); // 项间空行 = 松散列表
    const src = lines.join("\n");
    const chunks = chunkMarkdown(src, 160);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.slice(1).some(startsBlockContinuation)).toBe(false);
    expect(chunks.map((c) => c.src).join("\n")).toBe(src);
  });

  it("松散无序列表不被跨块切断", () => {
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) lines.push(`段 ${i}。`, "");
    for (let i = 0; i < 20; i++) lines.push(`- 项 ${i}`, "");
    const src = lines.join("\n");
    const chunks = chunkMarkdown(src, 160);
    expect(chunks.slice(1).some(startsBlockContinuation)).toBe(false);
  });

  it("多段引用块不被跨块切断", () => {
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) lines.push(`段 ${i}。`, "");
    for (let i = 0; i < 20; i++) lines.push(`> 引用第 ${i} 段`, ">");
    const src = lines.join("\n");
    const chunks = chunkMarkdown(src, 160);
    expect(chunks.slice(1).some(startsBlockContinuation)).toBe(false);
  });

  it("表格不被跨块切断", () => {
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) lines.push(`段 ${i}。`, "");
    lines.push("| A | B |", "|---|---|");
    for (let i = 0; i < 30; i++) lines.push(`| r${i} | v${i} |`);
    const src = lines.join("\n");
    const chunks = chunkMarkdown(src, 160);
    expect(chunks.slice(1).some(startsBlockContinuation)).toBe(false);
  });
});
