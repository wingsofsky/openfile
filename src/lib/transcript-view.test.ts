import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./acp";
import { documentReference, formatDocumentContext } from "./document-context";
import { groupTranscript, referencePath, summarizeActivity } from "./transcript-view";

const tool = (id: string, status: "pending" | "in_progress" | "completed" | "failed", path?: string): TranscriptItem => ({
  kind: "tool", toolCallId: id, title: `tool ${id}`, status, locations: path ? [{ path }] : [],
});

describe("groupTranscript", () => {
  it("相邻的工具调用与思考折成一组，消息 / 计划 / 事件行各自成块，原下标保留", () => {
    const items: TranscriptItem[] = [
      { kind: "user", text: "问" },
      tool("1", "completed"),
      { kind: "thought", text: "想" },
      tool("2", "failed"),
      { kind: "assistant", text: "答" },
      tool("3", "in_progress"),
      { kind: "plan", entries: [] },
      tool("4", "pending"),
    ];
    const blocks = groupTranscript(items);
    expect(blocks.map((b) => (b.kind === "activity" ? `a${b.items.length}` : b.item.kind))).toEqual([
      "user", "a3", "assistant", "a1", "plan", "a1",
    ]);
    const first = blocks[1];
    expect(first.kind === "activity" && first.items.map((x) => x.index)).toEqual([1, 2, 3]);
    expect(blocks[2].kind === "item" && blocks[2].index).toBe(4);
  });

  it("空转写不出块", () => expect(groupTranscript([])).toEqual([]));
});

describe("summarizeActivity", () => {
  it("计数、失败数、进行中的最新一条、去重路径", () => {
    const block = groupTranscript([
      tool("1", "completed", "/lib/a.md"),
      { kind: "thought", text: "…" },
      tool("2", "failed", "/lib/a.md"),
      tool("3", "in_progress", "/lib/b.md"),
      tool("4", "pending"),
    ])[0];
    if (block.kind !== "activity") throw new Error("应成一组");
    const s = summarizeActivity(block.items);
    expect([s.tools, s.thoughts, s.failed]).toEqual([4, 1, 1]);
    expect(s.running?.toolCallId).toBe("4");
    expect(s.paths).toEqual(["/lib/a.md", "/lib/b.md"]);
  });
});

describe("referencePath", () => {
  it("认得 formatDocumentContext 的产物，取回路径；普通消息不误判", () => {
    const text = formatDocumentContext(documentReference("/lib", '笔记/带"引号".md'));
    expect(referencePath(text)).toBe('笔记/带"引号".md');
    expect(referencePath("文档引用这个词我只是随口一提")).toBeNull();
    expect(referencePath("你好")).toBeNull();
  });
});
