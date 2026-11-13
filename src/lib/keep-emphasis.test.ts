import { describe, expect, it } from "vitest";
import { parseCritic } from "@openfile/protocol/criticmarkup";
import { keepEmphasis, resolveAll, resolveMark } from "./keep-emphasis";

describe("keepEmphasis：改完别让加粗失效", () => {
  it("接受删掉实体：加粗后面紧挨的字写成字符引用", () => {
    const src = "**加粗。**{--@a: &#x4F60;--}好的\n";
    expect(resolveMark(src, parseCritic(src)[0], true)).toBe("**加粗。**&#x597D;的\n");
    expect(resolveMark(src, parseCritic(src)[0], false)).toBe("**加粗。**&#x4F60;好的\n");
  });

  it("接受插在收尾分隔符后面的字", () => {
    const src = "**加粗。**{++@a: 新++} 后文\n";
    expect(resolveAll(src, true)).toBe("**加粗。**&#x65B0; 后文\n");
  });

  it("不需要时一个字都不改", () => {
    const src = "**粗**{++@a: x++}和*斜*{--@a: 删--}\n";
    expect(resolveAll(src, true)).toBe("**粗**x和*斜*\n");
    expect(keepEmphasis("a b", "a c", 2, 1)).toEqual({ text: "a c", at: 2, delta: 0 });
  });

  it("全部接受时每条都保住", () => {
    const src = "**一。**{--@a: &#x4F60;--}好\n\n**二。**{--@a: &#x4F60;--}好\n";
    expect(resolveAll(src, true)).toBe("**一。**&#x597D;\n\n**二。**&#x597D;\n");
  });
});
