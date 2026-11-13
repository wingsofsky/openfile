import { describe, expect, it } from "vitest";
import { contextPercent, fmtTokens } from "./token-format";

describe("展示用小工具", () => {
  it("令牌缩写：M / k / 原样", () => {
    expect(fmtTokens(1_234_567)).toBe("1.23M");
    expect(fmtTokens(45_600)).toBe("45.6k");
    expect(fmtTokens(9_999)).toBe("9999");
    expect(fmtTokens(0)).toBe("0");
  });
  it("令牌缩写：坏输入不显示成 NaN", () => {
    expect(fmtTokens(Number.NaN)).toBe("—");
    expect(fmtTokens(-1)).toBe("—");
  });

  it("上下文占比四舍五入", () => {
    expect(contextPercent(42_000, 200_000)).toBe(21);
    expect(contextPercent(0, 200_000)).toBe(0);
  });
  it("上下文占比越界夹到 100", () => {
    expect(contextPercent(300_000, 200_000)).toBe(100);
  });
  it("上下文占比：size 无效返回 null（不除零）", () => {
    expect(contextPercent(10, 0)).toBeNull();
    expect(contextPercent(10, Number.NaN)).toBeNull();
    expect(contextPercent(-1, 100)).toBeNull();
  });
});
