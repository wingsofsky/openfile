import { describe, expect, it } from "vitest";
import { changedLines, chunksBetween, documentChanges, planTurnUndo, touchedInTurn, turnLabel, type TurnChanges } from "./turn-changes";
import type { FileChange } from "./types";

describe("chunksBetween", () => {
  it("相隔较远的两处改动是两块；没改是零块", () => {
    const base = ["# 标题", "", "第一段。", "", "a", "b", "c", "d", "e", "", "最后一段。"].join("\n");
    const cur = base.replace("第一段。", "第一段改了。").replace("最后一段。", "最后一段也改了。");
    expect(chunksBetween(base, cur)).toHaveLength(2);
    expect(chunksBetween(base, base)).toHaveLength(0);
  });

  it("CRLF 与 LF 只差换行时不算改动；CRLF 文件里的真改动照样切出来", () => {
    const lf = "第一行\n第二行\n";
    expect(chunksBetween(lf, lf.replace(/\n/g, "\r\n"))).toHaveLength(0);
    expect(chunksBetween("甲\r\n乙\r\n", "甲\r\n丙\r\n")).toHaveLength(1);
  });

  it("新建文件（基线为空）是一整块", () => {
    expect(chunksBetween("", "新内容\n第二行\n")).toHaveLength(1);
  });
});

describe("changedLines", () => {
  const base = ["# 标题", "", "第一段。", "", "a", "b", "c", "d", "e", "", "最后一段。"].join("\n");
  it("改了的行（当前文档行号）", () => {
    const cur = base.replace("第一段。", "第一段改了。").replace("最后一段。", "最后一段也改了。");
    expect([...changedLines(base, cur)]).toEqual([3, 11]);
  });
  it("新增多行全部标出；没改是空集", () => {
    const cur = base.replace("第一段。", "第一段。\n\n插入一段。");
    // 空行归前归后都是合法 diff；插入的那段（第 5 行）一定在内
    const got = changedLines(base, cur);
    expect(got.has(5)).toBe(true);
    expect(got.size).toBe(2);
    expect(changedLines(base, base).size).toBe(0);
  });
  it("纯删除落在其后一行", () => {
    const cur = base.replace("c\n", "");
    expect([...changedLines(base, cur)]).toEqual([7]);
  });
});

describe("planTurnUndo", () => {
  const files: FileChange[] = [
    { path: "改了.md", status: "modified" },
    { path: "新建.md", status: "added" },
    { path: "删了.txt", status: "deleted" },
    { path: "又被改.md", status: "modified" },
    { path: "怪.bin", status: "other" },
  ];

  it("改过 / 删掉的恢复，新建的进废纸篓，轮后又被改的与认不出的跳过", () => {
    expect(planTurnUndo(files, ["又被改.md", "不相干.md"])).toEqual({
      restore: ["改了.md", "删了.txt"],
      trash: ["新建.md"],
      skipped: ["又被改.md", "怪.bin"],
    });
  });

  it("轮后又新建了同名文件也跳过，不进废纸篓", () => {
    expect(planTurnUndo([{ path: "新建.md", status: "added" }], ["新建.md"]).trash).toEqual([]);
  });
});

describe("documentChanges", () => {
  it("会话记录目录不算本轮改动", () => {
    const files: FileChange[] = [
      { path: "会话/内嵌/2026-10-18.md", status: "added" },
      { path: "会话/导入/索引.md", status: "modified" },
      { path: "会话记录.md", status: "modified" },
      { path: "稿/会话/内嵌/a.md", status: "added" },
    ];
    expect(documentChanges(files).map((f) => f.path)).toEqual(["会话记录.md", "稿/会话/内嵌/a.md"]);
  });
});

describe("touchedInTurn / turnLabel", () => {
  const tc: TurnChanges = { root: "/库", turn: 2, baseId: "a", headId: "b", files: [{ path: "x/说明.md", status: "modified" }] };
  it("只认同一文库里列出的路径", () => {
    expect(touchedInTurn(tc, "/库", "x/说明.md")?.status).toBe("modified");
    expect(touchedInTurn(tc, "/别的库", "x/说明.md")).toBeNull();
    expect(touchedInTurn(tc, "/库", "说明.md")).toBeNull();
    expect(touchedInTurn(null, "/库", "x/说明.md")).toBeNull();
  });
  it("快照标签", () => {
    expect(turnLabel(3, "前")).toBe("会话第 3 轮前");
  });
});
