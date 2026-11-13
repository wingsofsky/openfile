import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "./store";
import { currentFileContext } from "./agent-context";

beforeEach(() => {
  useApp.setState({ lib: { root: "/library", name: "library" }, tabs: [], activeId: null });
});

const open = (rel: string) => useApp.getState().openFile(rel);

describe("会话自动带当前文件", () => {
  it("附当前活动文件的路径，不含全文；换文件就换", () => {
    open("a.md");
    const a = currentFileContext("/library");
    expect(a?.sources).toEqual(["a.md"]);
    expect(a?.text).toContain('文库内路径："a.md"');
    expect(a?.text).toContain("未附带全文");
    open("b.md");
    expect(currentFileContext("/library")?.sources).toEqual(["b.md"]);
  });

  it("每次都附，不是只附一次", () => {
    open("a.md");
    expect(currentFileContext("/library")?.sources).toEqual(["a.md"]);
    expect(currentFileContext("/library")?.sources).toEqual(["a.md"]);
  });

  it("没打开文件、活动标签是特殊页、或文库已换：什么都不附", () => {
    expect(currentFileContext("/library")).toBeNull();
    useApp.setState({ tabs: [{ id: "spike:ime", rel: "", kind: "spike" }], activeId: "spike:ime" });
    expect(currentFileContext("/library")).toBeNull();
    open("a.md");
    expect(currentFileContext("/other")).toBeNull();
  });
});
