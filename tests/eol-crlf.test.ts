// @vitest-environment node
import { describe, expect, it } from "vitest";
import { detectEol, findAllEolTolerant, withEol } from "@openfile/protocol/eol";

describe("换行风格内核", () => {
  it("detectEol：CRLF 多于裸 LF 才算 CRLF；无换行 = LF", () => {
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("单行")).toBe("\n");
    expect(detectEol("")).toBe("\n");
    expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectEol("a\r\nb\nc\n")).toBe("\n");
  });

  it("withEol：统一换行，孤立 \\r 不动", () => {
    expect(withEol("a\nb\r\nc", "\r\n")).toBe("a\r\nb\r\nc");
    expect(withEol("a\nb\r\nc", "\n")).toBe("a\nb\nc");
    expect(withEol("a\rb", "\r\n")).toBe("a\rb");
  });

  it("findAllEolTolerant：LF 锚点对得上 CRLF 文档，命中的是文档原文", () => {
    const doc = "甲\r\n乙\r\n丙\r\n";
    expect(findAllEolTolerant(doc, "甲\n乙")).toEqual([{ index: 0, text: "甲\r\n乙" }]);
    expect(findAllEolTolerant(doc, "乙\r\n丙")).toEqual([{ index: 3, text: "乙\r\n丙" }]);
    expect(findAllEolTolerant("甲\n乙", "甲\r\n乙")).toEqual([{ index: 0, text: "甲\n乙" }]);
    expect(findAllEolTolerant(doc, "甲\n丙")).toEqual([]);
  });

  it("以换行打头的锚点不在 CRLF 中间重复命中", () => {
    expect(findAllEolTolerant("a\r\nb", "\nb")).toEqual([{ index: 1, text: "\r\nb" }]);
    expect(findAllEolTolerant("a\nb", "\nb")).toEqual([{ index: 1, text: "\nb" }]);
  });

  it("单行锚点：与 indexOf 循环同语义（含重叠出现）", () => {
    expect(findAllEolTolerant("aaa", "aa").map((h) => h.index)).toEqual([0, 1]);
    expect(findAllEolTolerant("x", "")).toEqual([]);
  });

  it("正则元字符按字面量", () => {
    expect(findAllEolTolerant("a.b\r\n(c)*", "a.b\n(c)*")).toEqual([{ index: 0, text: "a.b\r\n(c)*" }]);
    expect(findAllEolTolerant("axb\r\n(c)", "a.b\n(c)")).toEqual([]);
  });
});
