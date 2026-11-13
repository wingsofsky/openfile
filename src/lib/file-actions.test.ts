import { beforeEach, describe, expect, it } from "vitest";
import { reviewPrompt, targetsOf, topLevel } from "./file-actions";
import { useFiles } from "../state/files";

describe("多选的作用对象", () => {
  beforeEach(() => useFiles.setState({ selected: [], anchor: null }));

  it("topLevel：选了文件夹又选了它里面的东西，只留文件夹；同前缀的兄弟不误伤", () => {
    expect(topLevel(["docs", "docs/a.md", "docs/sub/b.md", "docs-old/x.md", "docs"])).toEqual(["docs", "docs-old/x.md"]);
  });

  it("targetsOf：行在多选之内 → 整个选区；在选区之外或只选了一项 → 只有这一行", () => {
    useFiles.setState({ selected: ["a.md", "b.md", "docs"] });
    expect(targetsOf("b.md")).toEqual(["a.md", "b.md", "docs"]);
    expect(targetsOf("c.md")).toEqual(["c.md"]);
    useFiles.setState({ selected: ["a.md"] });
    expect(targetsOf("a.md")).toEqual(["a.md"]);
  });
});

describe("交给 agent 的预设提示词", () => {
  it("带文件在磁盘上的精确绝对路径", () => {
    expect(reviewPrompt("/Users/me/lib", "docs/稿子.md")).toBe("看一下 /Users/me/lib/docs/稿子.md 我的批注，回答问题并应用改动");
  });
  it("Windows 文库根用反斜杠拼，剥掉 \\\\?\\ 前缀", () => {
    expect(reviewPrompt("\\\\?\\D:\\库", "docs/稿子.md")).toBe("看一下 D:\\库\\docs\\稿子.md 我的批注，回答问题并应用改动");
  });
});

