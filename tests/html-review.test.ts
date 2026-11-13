// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { htmlRelFor, htmlReviewRelFor, htmlToMarkdown } from "../packages/runtime/src/lib/html-review.ts";
import { htmlToReviewBound } from "../packages/runtime/src/api/workspace.ts";
import { tempDir } from "./helpers/paths.ts";
import { linkDir } from "./helpers/links.ts";

describe("htmlToMarkdown", () => {
  it("正文结构保留：标题、加粗、列表、表格、代码块、引用、相对链接与图片", async () => {
    const md = await htmlToMarkdown(
      `<h1>进展</h1><p>完成了 <strong>消融实验</strong>。</p><ul><li>一</li><li><a href="r/a.html">详情</a></li></ul>` +
        `<table><tr><th>模型</th><th>分数</th></tr><tr><td>A</td><td>0.81</td></tr></table>` +
        `<pre><code class="language-py">print(1)</code></pre><blockquote>引用</blockquote><img src="img/f.png" alt="图 1">`,
    );
    expect(md).toContain("# 进展");
    expect(md).toContain("完成了 **消融实验**。");
    expect(md).toContain("- 一\n- [详情](r/a.html)");
    expect(md).toContain("| 模型 | 分数 |\n| - | - |\n| A | 0.81 |");
    expect(md).toContain("```py\nprint(1)\n```");
    expect(md).toContain("> 引用");
    expect(md).toContain("![图 1](img/f.png)");
  });

  it("脚本、样式、svg、表单、注释丢掉；data: 图片只留 alt", async () => {
    const md = await htmlToMarkdown(
      `<head><title>t</title><style>p{}</style><script>alert(1)</script></head><body><p>正文</p>` +
        `<svg><text>坐标轴</text></svg><form><input value="x"></form><!-- 备注 -->` +
        `<img src="data:image/png;base64,AAAA" alt="分数曲线"><img src="data:image/png;base64,BBBB"></body>`,
    );
    expect(md).toBe("正文\n\n*分数曲线*\n");
  });

  it("& 与 < 不写成字符引用，选区才能对上源码", async () => {
    const md = await htmlToMarkdown("<p>Lee &amp; Park，a &lt; b</p>");
    expect(md).toBe("Lee & Park，a < b\n");
  });

  it("加粗、强调首尾的标点挪到标记外，不写字符引用", async () => {
    const md = await htmlToMarkdown("<p><strong>细纲交给模型。</strong>你亲手写的细纲<em>“原样”</em>传给模型。</p><p><strong>。</strong>你</p>");
    expect(md).toBe("**细纲交给模型**。你亲手写的细纲“*原样*”传给模型。\n\n**。**&#x4F60;\n");
  });

  it("审阅稿名与反查", () => {
    expect(htmlReviewRelFor("报告/x.html")).toBe("报告/x.html.review.md");
    expect(htmlRelFor("报告/x.html.review.md")).toBe("报告/x.html");
    expect(htmlRelFor("报告/x.HTM.review.md")).toBe("报告/x.HTM");
    expect(htmlRelFor("报告/x.docx.review.md")).toBeNull();
  });
});

describe("htmlToReviewBound", () => {
  it("建审阅稿；再开就沿用不覆盖；HTML 改过后标 stale", async () => {
    const root = tempDir("openfile-htmlreview-");
    try {
      fs.mkdirSync(path.join(root, "报告"));
      const html = path.join(root, "报告", "周报.html");
      fs.writeFileSync(html, "<h1>周报</h1><p>正文</p>");
      expect(await htmlToReviewBound(root, "报告/周报.html", root)).toEqual({ rel: "报告/周报.html.review.md", created: true, stale: false });
      const review = path.join(root, "报告", "周报.html.review.md");
      expect(fs.readFileSync(review, "utf8")).toBe("# 周报\n\n正文\n");

      fs.writeFileSync(review, "# 周报\n\n正文{++补充++}\n");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(html, past, past);
      expect(await htmlToReviewBound(root, "报告/周报.html", root)).toEqual({ rel: "报告/周报.html.review.md", created: false, stale: false });
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(html, future, future);
      expect(await htmlToReviewBound(root, "报告/周报.html", root)).toEqual({ rel: "报告/周报.html.review.md", created: false, stale: true });
      expect(fs.readFileSync(review, "utf8")).toBe("# 周报\n\n正文{++补充++}\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("路径攻击、换库、非 HTML 一律拒绝，零副作用", async () => {
    const root = tempDir("openfile-htmlreview-");
    const outside = tempDir("openfile-htmlreview-out-");
    try {
      fs.writeFileSync(path.join(outside, "x.html"), "<p>x</p>");
      linkDir(outside, path.join(root, "escape"));
      for (const rel of ["../x.html", path.join(outside, "x.html"), "x\0.html", "escape/x.html"]) {
        await expect(htmlToReviewBound(root, rel, root)).rejects.toThrow();
      }
      fs.writeFileSync(path.join(root, "a.html"), "<p>a</p>");
      await expect(htmlToReviewBound(root, "a.html", outside)).rejects.toThrow(/文库/);
      await expect(htmlToReviewBound(root, "a.md", root)).rejects.toThrow(/html/);
      expect(fs.readdirSync(outside)).toEqual(["x.html"]);
      expect(fs.readdirSync(root).sort()).toEqual(["a.html", "escape"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
