// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionWriter, formatHistoryContext, isSessionHistoryPath, readHistoryContext, searchSessionHistory, serializeSession } from "./session-history";
import type { ArchiveFile, Backend, Entry } from "./types";

afterEach(() => vi.useRealTimers());

describe("readable session archive", () => {
  it("archives visible dialogue and known state, excluding thought, tool titles and diagnostic secrets", () => {
    const md = serializeSession({ id: "unique", startedAt: "2026-09-12T00:00:00Z", agent: "demo", status: "ready", transcript: [
      { kind: "user", text: "请保留正文\n```js\na()\n```" }, { kind: "assistant", text: "已完成" },
      { kind: "thought", text: "PRIVATE_THOUGHT" }, { kind: "info", text: "API_KEY=SECRET" },
      { kind: "tool", toolCallId: "id", title: "curl -H secret", status: "completed", locations: [] },
    ] });
    expect(md).toContain("## 用户\n\n请保留正文\n```js\na()\n```");
    expect(md).toContain("## 助手\n\n已完成");
    expect(md).not.toMatch(/PRIVATE_THOUGHT|API_KEY|curl/);
  });

  it("coalesces streamed chunks and never lets an older in-flight snapshot overwrite the newest", async () => {
    vi.useFakeTimers();
    const finish: Array<() => void> = [];
    const written: string[] = [];
    const write = vi.fn((_path: string, content: string, root: string) => new Promise<void>((resolve) => {
      expect(root).toBe("/library-a");
      finish.push(() => { written.push(content); resolve(); });
    }));
    const writer = createSessionWriter({ root: "/library-a", path: "会话/内嵌/id.md", inLibrary: true, write, onState: () => undefined });
    writer.update("one"); writer.update("two");
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledTimes(1);
    writer.update("three"); writer.update("final");
    const flushed = writer.flush();
    finish.shift()!();
    await Promise.resolve(); await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(2);
    finish.shift()!();
    expect(await flushed).toBe(true);
    expect(written).toEqual(["two", "final"]);
    expect(writer.dirty).toBe(false);
  });

  it("retains a failed snapshot for explicit retry and exposes failure", async () => {
    const states: string[] = [];
    const write = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const writer = createSessionWriter({ root: "/a", path: "id.md", inLibrary: true, write, onState: (state) => states.push(`${state.status}:${state.error}`) });
    writer.update("must survive");
    expect(await writer.flush()).toBe(false);
    expect(writer.dirty).toBe(true);
    expect(states).toContain("error:disk full");
    expect(await writer.flush()).toBe(true);
    expect(write).toHaveBeenLastCalledWith("id.md", "must survive", "/a", null);
  });

  it("pauses queued old-library writes; resuming retains the original root binding", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = createSessionWriter({ root: "/old", path: "id.md", inLibrary: true, write, onState: () => undefined });
    writer.update("pending old transcript"); writer.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();
    expect(await writer.flush()).toBe(false);
    expect(await writer.resume()).toBe(true);
    expect(write).toHaveBeenCalledWith("id.md", "pending old transcript", "/old", null);
  });
});

const entry = (rel: string, isDir = false): Entry => ({ rel, name: rel.split("/").at(-1)!, isDir, ext: isDir ? "" : "md", size: 20, mtime: 100 });
const ARCHIVE = "2026-10-21T03-04-05-678Z-0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.md";
function historyIo(archives: ArchiveFile[] = []) {
  const dirs: Record<string, Entry[]> = {
    "": [entry("会话", true), entry("记忆", true)],
    "会话": [entry("会话/内嵌", true), entry("会话/导入", true)],
    "会话/内嵌": [entry("会话/内嵌/abc.md")],
    "会话/导入": [entry("会话/导入/索引.md"), entry("会话/导入/import.md")],
  };
  return {
    listDir: vi.fn(async (rel: string, root?: string) => { expect(root).toBe("/current"); return dirs[rel] ?? []; }),
    readText: vi.fn(async (_rel: string, _max?: number, root?: string) => {
      expect(root).toBe("/current"); return { content: "# 持久档案\n\n过去讨论了花园", truncated: false, size: 40, encoding: "utf-8" };
    }),
    listArchives: vi.fn(async (root: string) => { expect(root).toBe("/current"); return archives; }),
    readArchive: vi.fn(async (_name: string, _max: number | undefined, root: string) => {
      expect(root).toBe("/current"); return { content: "# 应用数据里的档案\n\n聊过花园排版", truncated: false, size: 40, encoding: "utf-8" };
    }),
  } satisfies Pick<Backend, "listDir" | "readText" | "listArchives" | "readArchive">;
}

describe("current-library history", () => {
  it("discovers embedded and imported transcripts from disk, excluding indexes", async () => {
    const io = historyIo();
    const result = await searchSessionHistory(io, "/current");
    expect(result.items.map((item) => item.path).sort()).toEqual(["会话/内嵌/abc.md", "会话/导入/import.md"].sort());
    expect(io.readText).toHaveBeenCalledTimes(2);
    expect((await searchSessionHistory(io, "/current", "花园")).items).toHaveLength(2);
  });

  it("also lists archives kept in app data for a folder that is not a library, read through the archive API", async () => {
    const io = historyIo([{ name: ARCHIVE, size: 40, mtime: 200 }]);
    const result = await searchSessionHistory(io, "/current");
    expect(result.items[0]).toMatchObject({ path: ARCHIVE, appData: true, source: "内嵌", title: "应用数据里的档案" });
    expect(result.items.filter((item) => item.appData)).toHaveLength(1);
    expect(io.readArchive).toHaveBeenCalledWith(ARCHIVE, 4096, "/current");
    expect(io.readText).not.toHaveBeenCalledWith(ARCHIVE, expect.anything(), expect.anything());
    expect((await searchSessionHistory(io, "/current", "排版")).items.map((item) => item.path)).toEqual([ARCHIVE]);

    const history = await readHistoryContext(io, "/current", ARCHIVE, true);
    expect(history).toMatchObject({ path: ARCHIVE, appData: true });
    expect(formatHistoryContext(history)).toContain(`来源: 应用数据/${ARCHIVE}`);
  });

  it("finds app-data archives even when the folder has no 会话 directory", async () => {
    const io = historyIo([{ name: ARCHIVE, size: 40, mtime: 200 }]);
    io.listDir.mockImplementation(async () => []);
    expect((await searchSessionHistory(io, "/current")).items.map((item) => item.path)).toEqual([ARCHIVE]);
  });

  it("rejects traversal and non-history paths before reading", async () => {
    const io = historyIo();
    for (const path of ["/tmp/x.md", "会话/内嵌/../../secret.md", "会话/内嵌/a\\b.md", "记忆/a.md", "会话/其他/x.md"]) {
      expect(isSessionHistoryPath(path)).toBe(false);
      await expect(readHistoryContext(io, "/current", path)).rejects.toThrow();
    }
    expect(io.readText).not.toHaveBeenCalled();
  });

  it("bounds restored context and labels it as quoted history rather than native resume or authorization", async () => {
    const io = historyIo();
    io.readText.mockResolvedValueOnce({ content: "x".repeat(30_000), truncated: false, size: 30_000, encoding: "utf-8" });
    const history = await readHistoryContext(io, "/current", "会话/内嵌/abc.md");
    expect(history.content).toHaveLength(24_000);
    expect(history.truncated).toBe(true);
    const prompt = formatHistoryContext(history);
    expect(prompt).toContain("不是原生恢复");
    expect(prompt).toContain("不代表本轮授权");
    expect(prompt).toContain("仅载入开头节选");
  });

  it("stops search after cancellation without continuing reads", async () => {
    const io = historyIo();
    const controller = new AbortController(); controller.abort();
    await expect(searchSessionHistory(io, "/current", "a", controller.signal)).rejects.toThrow("取消");
    expect(io.readText).not.toHaveBeenCalled();
  });
});
