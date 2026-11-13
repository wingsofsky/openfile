import { describe, expect, it } from "vitest";
import { documentReference, formatDocumentContext } from "./document-context";

describe("按路径引用文档", () => {
  it("只有路径，不带全文，提醒 agent 自己按路径读盘", () => {
    const text = formatDocumentContext(documentReference("/library", '笔记/带"引号".md'));
    expect(text).toContain('文库内路径："笔记/带\\"引号\\".md"');
    expect(text).toContain("未附带全文");
    expect(text).toContain("未包含源码编辑器中的未保存改动");
  });
});
