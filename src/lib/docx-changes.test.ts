import { describe, expect, it } from "vitest";
import { changedParagraphs } from "./docx-changes";

const run = (base: string[], current: string[]) => {
  const { marked, hunks } = changedParagraphs(base, current);
  return { marked: [...marked].sort((a, b) => a - b), hunks };
};

describe("docx 按段落标改动", () => {
  it("改写、新增的段落标在当前文档里", () => {
    expect(run(["甲", "乙", "丙"], ["甲", "乙（改）", "丙"])).toEqual({ marked: [1], hunks: 1 });
    expect(run(["甲", "丙"], ["甲", "乙", "丙"])).toEqual({ marked: [1], hunks: 1 });
  });

  it("纯删除标其后一段；删在末尾标最后一段；全删了没得标", () => {
    expect(run(["甲", "乙", "丙"], ["甲", "丙"])).toEqual({ marked: [1], hunks: 1 });
    expect(run(["甲", "乙"], ["甲"])).toEqual({ marked: [0], hunks: 1 });
    expect(run(["甲"], [])).toEqual({ marked: [], hunks: 1 });
  });

  it("不相连的改动各算一处；没改就是零处", () => {
    expect(run(["甲", "乙", "丙", "丁"], ["甲（改）", "乙", "丙", "丁（改）"])).toEqual({ marked: [0, 3], hunks: 2 });
    expect(run(["甲", "乙"], ["甲", "乙"])).toEqual({ marked: [], hunks: 0 });
  });

  it("同一处里先删后加：只标新段落，不另标后一段", () => {
    expect(run(["甲", "乙", "丙", "丁"], ["甲", "新", "丁"])).toEqual({ marked: [1], hunks: 1 });
  });
});
