import { describe, expect, it, vi } from "vitest";
import { computeParts } from "./DiffView";

describe("中文差异保留精确原文", () => {
  it("实际调用 Intl.Segmenter，并以中文词为修改单元", async () => {
    const spy = vi.spyOn(Intl.Segmenter.prototype, "segment");
    const parts = await computeParts("我们研究科学方法。", "我们研究工程方法。");
    expect(spy).toHaveBeenCalled();
    expect(parts.filter(p => p.removed).map(p => p.value).join("")).toBe("科学");
    expect(parts.filter(p => p.added).map(p => p.value).join("")).toBe("工程");
    spy.mockRestore();
  });
  it.each([
    ["甲 乙\n丙", "甲  乙\r\n丙\t"], ["  ", " \t\n"], ["word\r\n结束", "word\n结束"],
  ])("空白变化也能无损重建新旧两侧：%j → %j", async (oldText, newText) => {
    const parts = await computeParts(oldText, newText);
    expect(parts.filter(p => !p.added).map(p => p.value).join("")).toBe(oldText);
    expect(parts.filter(p => !p.removed).map(p => p.value).join("")).toBe(newText);
    expect(parts.some(p => p.added || p.removed)).toBe(true);
  });
});
