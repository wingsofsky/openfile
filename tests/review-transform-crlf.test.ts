// @vitest-environment node
import { describe, expect, it } from "vitest";
import { analyzeReview, transformChunk } from "../src/lib/review-transform";

describe("审阅渲染变换：CRLF 文档", () => {
  it("跨空段落（\\r\\n\\r\\n）的标记按行拆开，与 LF 的 \\n\\n 同口径，换行原样留着", () => {
    for (const [src, eol] of [["前{++@a: 一段\n\n二段++}后", "\n"], ["前{++@a: 一段\r\n\r\n二段++}后", "\r\n"]]) {
      const out = transformChunk(src, 0, analyzeReview(src));
      expect(out, JSON.stringify(src)).not.toContain("{++");
      expect(out, JSON.stringify(src)).toContain(`>一段</ins>${eol}${eol}<ins `);
      expect(out, JSON.stringify(src)).toContain(">二段</ins>后");
    }
  });

  it("不跨空段落的 CRLF 标记照常变换，且不增删换行", () => {
    const src = "第一行 {++@a: 新增++}\r\n第二行 {--@b: 删掉--}\r\n";
    const out = transformChunk(src, 0, analyzeReview(src));
    expect(out).toContain('<ins class="cm-ins" data-cmid="0" data-author="a">新增</ins>');
    expect(out).toContain('<del class="cm-del" data-cmid="1" data-author="b">删掉</del>');
    expect(out.split("\r\n")).toHaveLength(src.split("\r\n").length);
  });

  it("标记内单个 CRLF（非空段落）仍算行内", () => {
    const src = "{~~@c: 旧\r\n行~>新行~~}";
    const out = transformChunk(src, 0, analyzeReview(src));
    expect(out).toContain("cm-sub");
  });
});
