import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "./store";

describe("tab 管理", () => {
  beforeEach(() => {
    useApp.setState({ tabs: [], activeId: null });
  });

  it("打开文件去重并激活", () => {
    const s = useApp.getState();
    s.openFile("a.md");
    s.openFile("b.md");
    s.openFile("a.md");
    const { tabs, activeId } = useApp.getState();
    expect(tabs.map((t) => t.rel)).toEqual(["a.md", "b.md"]);
    expect(activeId).toBe("a.md");
  });

  it("关闭激活 tab 后激活邻位", () => {
    const s = useApp.getState();
    s.openFile("a.md");
    s.openFile("b.md");
    s.openFile("c.md");
    s.closeTab("c.md");
    expect(useApp.getState().activeId).toBe("b.md");
    s.closeTab("a.md"); // 关闭非激活 tab 不影响激活
    expect(useApp.getState().activeId).toBe("b.md");
    s.closeTab("b.md");
    expect(useApp.getState().activeId).toBeNull();
    expect(useApp.getState().tabs).toHaveLength(0);
  });

  it("关闭中间激活 tab 激活右邻", () => {
    const s = useApp.getState();
    s.openFile("a.md");
    s.openFile("b.md");
    s.openFile("c.md");
    s.setActive("b.md");
    s.closeTab("b.md");
    expect(useApp.getState().activeId).toBe("c.md");
  });

  it("试验场 tab 单例", () => {
    const s = useApp.getState();
    s.openSpike();
    s.openSpike();
    expect(useApp.getState().tabs.filter((t) => t.kind === "spike")).toHaveLength(1);
    expect(useApp.getState().activeId).toBe("spike:ime");
  });

  it("字号缩放夹取边界", () => {
    const s = useApp.getState();
    useApp.setState({ fontScale: 1 });
    for (let i = 0; i < 30; i++) s.adjustFont(0.05);
    expect(useApp.getState().fontScale).toBeLessThanOrEqual(1.4);
    for (let i = 0; i < 30; i++) s.adjustFont(-0.05);
    expect(useApp.getState().fontScale).toBeGreaterThanOrEqual(0.85);
  });
});

describe("文库栏收起", () => {
  it("toggleRail 来回切换", () => {
    useApp.setState({ railCollapsed: false });
    useApp.getState().toggleRail();
    expect(useApp.getState().railCollapsed).toBe(true);
    useApp.getState().toggleRail();
    expect(useApp.getState().railCollapsed).toBe(false);
  });
});

describe("文件管理后的 tab 跟随", () => {
  beforeEach(() => {
    useApp.setState({ tabs: [], activeId: null });
  });

  it("目录改名：其下文件 tab 改指新路径，激活态跟随，别的不动", () => {
    const s = useApp.getState();
    s.openFile("docs/a.md");
    s.openFile("docs-old.md");
    s.openFile("docs/sub/b.md");
    s.retargetTabs("docs", "文档");
    const { tabs, activeId } = useApp.getState();
    expect(tabs.map((t) => t.id)).toEqual(["文档/a.md", "docs-old.md", "文档/sub/b.md"]);
    expect(tabs[0].rel).toBe("文档/a.md");
    expect(activeId).toBe("文档/sub/b.md");
  });

  it("移到废纸篓：关掉它自己与其下的 tab", () => {
    const s = useApp.getState();
    s.openFile("docs/a.md");
    s.openFile("keep.md");
    s.openFile("docs/sub/b.md");
    s.closeTabsUnder("docs");
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(["keep.md"]);
    expect(useApp.getState().activeId).toBe("keep.md");
  });
});
