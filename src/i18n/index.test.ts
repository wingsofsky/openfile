import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "./index";

describe("t()", () => {
  afterEach(() => setLocale("zh"));

  it("英文按数量取单复数，中文原样填数", () => {
    setLocale("en");
    expect(t("第 {0} 轮改了 {1} 个文件", [1, 1])).toBe("Turn 1 changed 1 file");
    expect(t("第 {0} 轮改了 {1} 个文件", [2, 3])).toBe("Turn 2 changed 3 files");
    expect(t("{0} 条批注", [0])).toBe("0 comments");
    expect(t("已撤回第 {0} 轮：{1} 个文件回到轮前。", [1, 1])).toBe("Undid turn 1: 1 file is back to how it was before it.");
    expect(t("{0} 个文件", ["1,234"])).toBe("1,234 files");
    setLocale("zh");
    expect(t("第 {0} 轮改了 {1} 个文件", [1, 1])).toBe("第 1 轮改了 1 个文件");
  });

  it("缺变量时占位原样留着", () => {
    setLocale("en");
    expect(t("第 {0} 轮改了 {1} 个文件", [1])).toBe("Turn 1 changed {1} {1|file|files}");
  });
});
