// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { absToRel, applyUpdate, contentText, sliceLines, type TranscriptItem } from "./acp";

const ROOT = "/Users/me/我的文库";

describe("absToRel —— fs 代理的快速失败层", () => {
  it("库内路径映射为相对路径", () => {
    expect(absToRel(ROOT, `${ROOT}/docs/第一章.md`)).toBe("docs/第一章.md");
    expect(absToRel(ROOT, `${ROOT}/a.md`)).toBe("a.md");
  });

  it("词法归一：., .., 重复斜杠", () => {
    expect(absToRel(ROOT, `${ROOT}/docs/./a.md`)).toBe("docs/a.md");
    expect(absToRel(ROOT, `${ROOT}/docs//a.md`)).toBe("docs/a.md");
    expect(absToRel(ROOT, `${ROOT}/docs/../b.md`)).toBe("b.md");
  });

  it("攻击：根之外 / .. 爬出 / 前缀相似目录 / 相对路径 / NUL", () => {
    expect(absToRel(ROOT, "/etc/hosts")).toBeNull();
    expect(absToRel(ROOT, `${ROOT}/../隔壁/秘密.md`)).toBeNull();
    expect(absToRel(ROOT, `${ROOT}/docs/../../越界.md`)).toBeNull();
    expect(absToRel(ROOT, `${ROOT}外面/x.md`)).toBeNull(); // 前缀相似但不是子路径
    expect(absToRel(ROOT, "docs/a.md")).toBeNull(); // 非绝对路径
    expect(absToRel(ROOT, `${ROOT}/a\0.md`)).toBeNull();
    expect(absToRel(ROOT, "/")).toBeNull();
  });

  it("根本身与根尾斜杠", () => {
    expect(absToRel(ROOT, ROOT)).toBeNull();
    expect(absToRel(`${ROOT}/`, `${ROOT}/a.md`)).toBe("a.md");
  });
});

describe("sliceLines —— fs/read_text_file 的 line/limit", () => {
  const text = "一\n二\n三\n四";
  it("默认全量", () => {
    expect(sliceLines(text)).toBe(text);
    expect(sliceLines(text, null, null)).toBe(text);
  });
  it("行号 1 起始 + 行数", () => {
    expect(sliceLines(text, 2)).toBe("二\n三\n四");
    expect(sliceLines(text, 2, 2)).toBe("二\n三");
    expect(sliceLines(text, null, 1)).toBe("一");
  });
  it("越界不炸", () => {
    expect(sliceLines(text, 99)).toBe("");
    expect(sliceLines(text, 1, 0)).toBe("");
  });
});

const chunk = (
  kind: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
  text: string,
): SessionUpdate => ({ sessionUpdate: kind, content: { type: "text", text } });

describe("applyUpdate —— 转写折叠", () => {
  it("连续同类文本块合并，异类断开", () => {
    let t: TranscriptItem[] = [];
    t = applyUpdate(t, chunk("agent_message_chunk", "你"));
    t = applyUpdate(t, chunk("agent_message_chunk", "好"));
    t = applyUpdate(t, chunk("agent_thought_chunk", "（想）"));
    t = applyUpdate(t, chunk("agent_message_chunk", "再见"));
    expect(t).toEqual([
      { kind: "assistant", text: "你好" },
      { kind: "thought", text: "（想）" },
      { kind: "assistant", text: "再见" },
    ]);
  });

  it("tool_call → tool_call_update 就地合并；update 先到时容错补入", () => {
    let t: TranscriptItem[] = [];
    t = applyUpdate(t, {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "改写第三段",
      kind: "edit",
      status: "pending",
      locations: [{ path: "/lib/a.md" }],
    });
    t = applyUpdate(t, chunk("agent_message_chunk", "改完了"));
    t = applyUpdate(t, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
    expect(t[0]).toMatchObject({ kind: "tool", status: "completed", title: "改写第三段" });
    expect(t[1]).toEqual({ kind: "assistant", text: "改完了" });

    const orphan = applyUpdate([], {
      sessionUpdate: "tool_call_update",
      toolCallId: "c9",
      status: "in_progress",
    });
    expect(orphan[0]).toMatchObject({ kind: "tool", toolCallId: "c9", status: "in_progress" });
  });

  it("plan 整体替换；plan_removed 移除", () => {
    let t: TranscriptItem[] = [];
    const e1 = [{ content: "读文档", priority: "high", status: "pending" } as const];
    const e2 = [{ content: "读文档", priority: "high", status: "completed" } as const];
    t = applyUpdate(t, { sessionUpdate: "plan", entries: [...e1] });
    t = applyUpdate(t, chunk("agent_message_chunk", "开工"));
    t = applyUpdate(t, { sessionUpdate: "plan", entries: [...e2] });
    expect(t.filter((i) => i.kind === "plan")).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: "plan", entries: e2 });
    t = applyUpdate(t, { sessionUpdate: "plan_removed", planId: "p1" } as SessionUpdate);
    expect(t.filter((i) => i.kind === "plan")).toHaveLength(0);
  });

  it("非转写类更新原样返回同一引用（交由控制器处理）", () => {
    const t: TranscriptItem[] = [{ kind: "info", text: "x" }];
    const out = applyUpdate(t, {
      sessionUpdate: "current_mode_update",
      currentModeId: "yolo",
    } as SessionUpdate);
    expect(out).toBe(t);
  });

  it("非文本内容块进占位符", () => {
    expect(contentText({ type: "image", data: "", mimeType: "image/png" })).toBe("〔图片〕");
    expect(
      contentText({ type: "resource_link", uri: "file:///x/a.md", name: "a.md" }),
    ).toBe("〔资源：a.md〕");
  });
});
