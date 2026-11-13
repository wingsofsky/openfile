import { describe, expect, it } from "vitest";
import type { TextRead } from "./types";
import { readBom } from "./complete-text";

const record = (content: string, extra = 0): TextRead => ({ content, size: new TextEncoder().encode(content).length + extra, encoding: "utf-8", truncated: false });

describe("readBom：完整 UTF-8 读取写回时补回 BOM", () => {
  it("比解码文本多 3 字节 = 原文件有 BOM", () => {
    expect(readBom(record("正文", 3))).toBe("\uFEFF");
    expect(readBom(record("正文"))).toBe("");
  });

  it("截断、非 UTF-8、字节数对不上时不补", () => {
    expect(readBom({ ...record("正文", 3), truncated: true })).toBe("");
    expect(readBom({ ...record("正文", 3), encoding: "gbk" })).toBe("");
    expect(readBom(record("正文", 5))).toBe("");
  });
});
