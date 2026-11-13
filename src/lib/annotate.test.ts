import { describe, expect, it } from "vitest";
import { planAnnotation } from "./annotate";
import { parseCritic } from "@openfile/protocol/criticmarkup";

const FULL = "# 章\n\n窗外的雨声敲着玻璃。\n\n他想起了很多年前的事情。\n\n```\n代码里的雨声\n```\n\n重复。重复。\n";
const base = { full: FULL, chunkSrc: FULL, chunkOffset: 0, author: "alice" } as const;

describe("planAnnotation", () => {
  it("批注：插在选区之后，可解析、带署名", () => {
    const r = planAnnotation({ ...base, selected: "窗外的雨声敲着玻璃。", action: "comment", payload: "铺垫不够" });
    if (!r.ok) throw new Error(r.error);
    expect(r.next).toContain("{==窗外的雨声敲着玻璃。==}{>>@alice: 铺垫不够<<}");
    expect(parseCritic(r.next).some((s) => s.kind === "comment" && s.author === "alice")).toBe(true);
  });

  it("建议删除：选区变划线标记", () => {
    const r = planAnnotation({ ...base, selected: "很多年前的", action: "del" });
    if (!r.ok) throw new Error(r.error);
    expect(r.next).toContain("他想起了{--@alice: 很多年前的--}事情。");
  });

  it("建议替换：{~~旧~>新~~}", () => {
    const r = planAnnotation({ ...base, selected: "敲着玻璃", action: "sub", payload: "打在窗棂上" });
    if (!r.ok) throw new Error(r.error);
    expect(r.next).toContain("{~~@alice: 敲着玻璃~>打在窗棂上~~}");
  });

  it("给了精确偏移：重复出现的文字也按偏移定位；偏移对不上就退回文字搜索", () => {
    const second = FULL.lastIndexOf("重复。");
    const r = planAnnotation({ ...base, selected: "重复。", action: "mark", at: second });
    if (!r.ok) throw new Error(r.error);
    expect(r.next.endsWith("重复。{==重复。==}\n")).toBe(true);
    expect(planAnnotation({ ...base, selected: "重复。", action: "mark", at: 0 }).ok).toBe(false);
  });

  it("多处出现拒绝、找不到拒绝", () => {
    const dup = planAnnotation({ ...base, selected: "重复。", action: "del" });
    expect(dup.ok).toBe(false);
    const miss = planAnnotation({ ...base, selected: "不存在的句子", action: "del" });
    expect(miss.ok).toBe(false);
  });

  it("代码区拒绝", () => {
    const r = planAnnotation({ ...base, selected: "代码里的雨声", action: "comment", payload: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("字面量");
  });

  it("与已有标记重叠拒绝（选中了标记内部的文字）", () => {
    const withMark = FULL.replace("很多年前的", "{--@a: 很多年前的--}");
    const r = planAnnotation({ ...base, full: withMark, chunkSrc: withMark, selected: "很多年前", action: "del" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("重叠");
  });

  it("定界符注入拒绝且不产出", () => {
    const r = planAnnotation({ ...base, selected: "敲着玻璃", action: "sub", payload: "坏~~}东西" });
    expect(r.ok).toBe(false);
  });

  it("chunk 偏移换算正确", () => {
    const chunkSrc = "他想起了很多年前的事情。";
    const off = FULL.indexOf(chunkSrc);
    const r = planAnnotation({ ...base, chunkSrc, chunkOffset: off, selected: "事情", action: "comment", payload: "展开" });
    if (!r.ok) throw new Error(r.error);
    expect(r.next).toContain("{==事情==}{>>@alice: 展开<<}。");
  });
});
