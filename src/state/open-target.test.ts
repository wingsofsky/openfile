import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ takeOpenTargets: vi.fn(), setLibrary: vi.fn(), getIndexCount: vi.fn() }));
const session = vi.hoisted(() => ({ stopSession: vi.fn() }));
vi.mock("../lib/backend", () => ({ backend: api }));
vi.mock("../lib/agent-controller", () => session);
import { useApp } from "./store";
import { useFiles } from "./files";

// 操作系统交来的打开请求（open_target.rs 推断好的工作区 + 文档）在前端怎么落地
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers(); // setLibraryPath 两秒后补查索引，不让它跑出测试
  session.stopSession.mockResolvedValue(true);
  useApp.setState({ lib: { root: "D:\\工作\\仓库", name: "仓库" }, tabs: [], activeId: null, openNotice: null });
  useFiles.setState({ expand: null });
});
afterEach(() => {
  vi.useRealTimers();
});

it("工作区就是当前文库（盘符大小写、分隔符不同也算）：不切库，开文档并在树里展开到它", async () => {
  api.takeOpenTargets.mockResolvedValue([{ root: "d:/工作/仓库", rel: "文档/稿.md" }]);
  await useApp.getState().drainOpenTargets();
  expect(api.setLibrary).not.toHaveBeenCalled();
  expect(useApp.getState().activeId).toBe("文档/稿.md");
  expect(useFiles.getState().expand?.rel).toBe("文档/稿.md");
});

it("别的工作区：先切库再开；连着来几个请求以最后一个为准，文件夹只切库", async () => {
  api.takeOpenTargets.mockResolvedValue([{ root: "/a", rel: "x.md" }, { root: "/b", rel: null }]);
  api.setLibrary.mockResolvedValue({ root: "/b", name: "b" });
  await useApp.getState().drainOpenTargets();
  expect(api.setLibrary).toHaveBeenCalledTimes(1);
  expect(api.setLibrary).toHaveBeenCalledWith("/b");
  expect(useApp.getState().lib?.root).toBe("/b");
  expect(useApp.getState().tabs).toEqual([]);
});

it("切库失败：状态栏说清楚打不开的是哪份、为什么", async () => {
  api.takeOpenTargets.mockResolvedValue([{ root: "/gone", rel: "a.md" }]);
  api.setLibrary.mockRejectedValue(new Error("路径不可访问"));
  await useApp.getState().drainOpenTargets();
  expect(useApp.getState().openNotice).toContain("a.md");
  expect(useApp.getState().openNotice).toContain("路径不可访问");
  expect(useApp.getState().lib?.root).toBe("D:\\工作\\仓库");
});

it("没有排队的请求：什么都不动", async () => {
  api.takeOpenTargets.mockResolvedValue([]);
  await useApp.getState().drainOpenTargets();
  expect(api.setLibrary).not.toHaveBeenCalled();
  expect(useApp.getState().openNotice).toBeNull();
});
