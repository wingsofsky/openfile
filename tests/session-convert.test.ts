// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  archiveChecksum,
  archiveUntouched,
  BUCKET_MISC,
  BUCKET_TEMP,
  BUCKET_UNKNOWN,
  buildPromptBooks,
  detectFormat,
  isSubsetSession,
  parseSession,
  projectBucket,
  redactText,
  renderMarkdown,
  sanitizeBucket,
  suggestFileName,
  withChecksum,
} from "../packages/runtime/src/lib/session-convert.mjs";

const ccLine = (o: Record<string, unknown>) => JSON.stringify(o);

const ccFixture = [
  ccLine({ type: "queue-operation", timestamp: "2026-08-27T20:03:21.172Z" }),
  ccLine({
    type: "user",
    sessionId: "feed0000-aaaa-4bbb-8ccc-000000000000",
    isSidechain: false,
    cwd: "/Users/dev/paper",
    gitBranch: "main",
    timestamp: "2026-08-27T20:03:21.228Z",
    message: { role: "user", content: "第一条用户消息\n\n带换行，逐字保留。" },
  }),
  ccLine({ type: "custom-title", sessionId: "feed0000", customTitle: "手拍标题" }),
  ccLine({ type: "ai-title", sessionId: "feed0000", aiTitle: "AI 标题" }),
  ccLine({
    type: "assistant",
    sessionId: "feed0000",
    timestamp: "2026-08-27T20:03:34.565Z",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "内心戏不入档" }] },
  }),
  ccLine({
    type: "assistant",
    sessionId: "feed0000",
    timestamp: "2026-08-27T20:03:34.570Z",
    message: { role: "assistant", content: [{ type: "text", text: "先说结论。" }] },
  }),
  ccLine({
    type: "assistant",
    sessionId: "feed0000",
    timestamp: "2026-08-27T20:03:35.210Z",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Read", input: {} },
        { type: "tool_use", name: "Read", input: {} },
        { type: "tool_use", name: "Bash", input: {} },
      ],
    },
  }),
  // 工具输出经 user 行回传：不是人话，不成轮
  ccLine({
    type: "user",
    sessionId: "feed0000",
    timestamp: "2026-08-27T20:03:35.680Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "大坨输出" }] },
  }),
  // 斜杠命令展开是 harness 噪声
  ccLine({
    type: "user",
    sessionId: "feed0000",
    timestamp: "2026-08-27T20:04:00.000Z",
    message: { role: "user", content: "<command-name>/foo</command-name>" },
  }),
  // 子代理转写默认跳过
  ccLine({
    type: "user",
    sessionId: "feed0000",
    isSidechain: true,
    timestamp: "2026-08-27T20:05:00.000Z",
    message: { role: "user", content: "子代理内部提示词" },
  }),
  ccLine({
    type: "user",
    sessionId: "feed0000",
    timestamp: "2026-08-27T20:06:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "第二条，数组形态的用户消息。" }] },
  }),
].join("\n");

describe("claude-code 转写解析", () => {
  it("识别格式、优先手拍标题、抽 id/项目/分支", () => {
    expect(detectFormat(ccFixture)).toBe("claude-code");
    const s = parseSession(ccFixture, "claude-code");
    expect(s.title).toBe("手拍标题");
    expect(s.id).toBe("feed0000-aaaa-4bbb-8ccc-000000000000");
    expect(s.cwd).toBe("/Users/dev/paper");
    expect(s.branch).toBe("main");
  });

  it("用户逐字成轮；工具输出/命令噪声/子代理不成轮；助手折叠工具", () => {
    const s = parseSession(ccFixture, "claude-code");
    expect(s.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(s.turns[0].text).toBe("第一条用户消息\n\n带换行，逐字保留。");
    expect(s.turns[1].text).toBe("先说结论。");
    expect(s.turns[1].tools.get("Read")).toBe(2);
    expect(s.turns[1].tools.get("Bash")).toBe(1);
    expect(s.turns[2].text).toBe("第二条，数组形态的用户消息。");
  });

  it("--sidechains 时子代理轮进档", () => {
    const s = parseSession(ccFixture, "claude-code", { sidechains: true });
    expect(s.turns.some((t) => t.text.includes("子代理内部提示词"))).toBe(true);
  });

  it("渲染：思考绝不出现，工具折叠一行，用户原文在", () => {
    const md = renderMarkdown(parseSession(ccFixture, "claude-code"), {
      importedAt: "2026-08-28 09:00",
      originPath: "/tmp/x.jsonl",
    });
    expect(md).toContain("# 会话：手拍标题");
    expect(md).toContain("第一条用户消息");
    expect(md).toContain("〔工具〕Read ×2 · Bash");
    expect(md).not.toContain("内心戏");
    expect(md).not.toContain("大坨输出");
  });

  it("档案名：时间戳 + id 前 8 位 + 标题 slug（危险字符洗掉）", () => {
    const s = parseSession(ccFixture, "claude-code");
    s.title = "a/b:c*d 论文?包";
    const name = suggestFileName(s);
    expect(name).toMatch(/^20260827-\d{4}-feed0000-a-b-c-d-论文-包\.md$/);
  });
});

describe("其它格式", () => {
  it("codex：event_msg 兜底成轮", () => {
    const raw = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-27T10:00:00Z", payload: { id: "abc123", cwd: "/w" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-27T10:00:01Z", payload: { type: "user_message", message: "codex 用户消息" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-27T10:00:02Z", payload: { type: "agent_message", message: "codex 回复" } }),
    ].join("\n");
    expect(detectFormat(raw)).toBe("codex");
    const s = parseSession(raw, "codex");
    expect(s.id).toBe("abc123");
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "codex 用户消息"],
      ["assistant", "codex 回复"],
    ]);
  });

  it("codex：response_item 存在时优先于 event_msg", () => {
    const raw = [
      JSON.stringify({ type: "response_item", timestamp: "t", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "正主" }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "t", payload: { type: "user_message", message: "重复回显" } }),
    ].join("\n");
    const s = parseSession(raw, "codex");
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].text).toBe("正主");
  });

  it("gemini history 检查点", () => {
    const raw = JSON.stringify({
      history: [
        { role: "user", parts: [{ text: "gemini 问" }] },
        { role: "model", parts: [{ text: "gemini 答" }] },
      ],
    });
    expect(detectFormat(raw)).toBe("gemini-history");
    const s = parseSession(raw, "gemini-history");
    expect(s.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("generic jsonl 兜底：role+content 就能成档", () => {
    const raw = [
      JSON.stringify({ role: "human", content: "任意 agent 的用户消息" }),
      JSON.stringify({ role: "ai", text: "任意 agent 的回复" }),
      JSON.stringify({ kind: "noise" }),
    ].join("\n");
    expect(detectFormat(raw)).toBe("generic-jsonl");
    const s = parseSession(raw, "generic-jsonl");
    expect(s.turns).toHaveLength(2);
    expect(s.title).toBe("任意 agent 的用户消息");
  });

  it("空输入不误判", () => {
    expect(detectFormat("")).toBeNull();
    expect(detectFormat("纯文本不是转写")).toBeNull();
  });
});

const dispatchFixture = [
  ccLine({
    type: "user",
    sessionId: "aaaa1111-0000-0000-0000-000000000000",
    timestamp: "2026-08-28T09:00:00.000Z",
    message: { role: "user", content: "派个盲审" },
  }),
  ccLine({
    type: "assistant",
    sessionId: "aaaa1111",
    timestamp: "2026-08-28T09:00:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "派发盲审子代理。" },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Agent",
          input: { description: "Opus 盲读博士评审", subagent_type: "general-purpose", model: "opus", prompt: "你是零背景博士评审……不要客套。" },
        },
        { type: "tool_use", id: "toolu_02", name: "Read", input: {} },
      ],
    },
  }),
  ccLine({
    type: "user",
    sessionId: "aaaa1111",
    timestamp: "2026-08-28T09:10:00.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "盲审结论：三条没看懂。" }] },
  }),
].join("\n");

describe("子代理派发（提示词资产保全）", () => {
  it("派发单独保留：提示词全文 + 答复缝合；普通工具照常折叠", () => {
    const s = parseSession(dispatchFixture, "claude-code");
    const asst = s.turns.find((t) => t.role === "assistant")!;
    expect(asst.agents).toHaveLength(1);
    expect(asst.agents[0].prompt).toContain("零背景博士评审");
    expect(asst.agents[0].model).toBe("opus");
    expect(asst.agents[0].reply).toBe("盲审结论：三条没看懂。");
    expect(asst.tools.get("Read")).toBe(1);
    expect(asst.tools.has("Agent")).toBe(false);
    const md = renderMarkdown(s);
    expect(md).toContain("〔派发〕general-purpose/opus · Opus 盲读博士评审");
    expect(md).toContain("盲审结论：三条没看懂。");
  });
});

describe("fork 检测", () => {
  const mk = (msgs: string[]) =>
    parseSession(
      msgs.map((m, i) => ccLine({ type: "user", sessionId: "s", timestamp: `2026-08-28T09:0${i}:00.000Z`, message: { role: "user", content: m } })).join("\n"),
      "claude-code",
    );
  it("用户消息集合真包含 ⇒ 疑似子集；相等或无关 ⇒ 否", () => {
    const a = mk(["甲", "乙"]);
    const b = mk(["甲", "乙", "丙"]);
    const c = mk(["丁"]);
    expect(isSubsetSession(a, b)).toBe(true);
    expect(isSubsetSession(b, a)).toBe(false);
    expect(isSubsetSession(a, a)).toBe(false);
    expect(isSubsetSession(c, b)).toBe(false);
  });
});

describe("脱敏（白名单 + 关键词行高熵 + 疑似清单）", () => {
  it("白名单模式命中即替换——含 s2k- 这类非常见前缀", () => {
    const r = redactText("S2 API Key: s2k-AbCdEf123456789012345\n另一把 sk-abcDEF1234567890abcdef12");
    expect(r.text).not.toContain("s2k-AbCdEf");
    expect(r.text).not.toContain("sk-abcDEF");
    expect(r.text).toContain("[已脱敏:semantic-scholar");
    expect(r.redactions.map((x) => x.type).sort()).toEqual(["openai/anthropic", "semantic-scholar"].sort());
  });
  it("关键词行上的高熵 token 被替换；纯 hex（git hash）不动", () => {
    const r = redactText("my token: Qz9RtY7uIoP2aSdF4gHjK1lZ\ncommit a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0");
    expect(r.text).toContain("[已脱敏:keyword-line");
    expect(r.text).toContain("a1b2c3d4e5f6");
  });
  it("无关键词的超长混合 token 只进疑似清单，不替换", () => {
    const tok = "Xy7Zw1Qa2Ws3Ed4Rf5Tg6Yh7Uj8Ik9Ol0Pz1Xc2Vb3Nm4";
    const r = redactText(`正文里出现 ${tok} 这样的串`);
    expect(r.text).toContain(tok);
    expect(r.suspects.length).toBe(1);
  });
  it("slug/文件名/工具名样 token 不进疑似清单（多下划线、多连字符、日期开头）", () => {
    const r = redactText(
      [
        "mcp__Claude_Browser__read_network_requests_v2X9",
        "2026-08-20__project_notes_review__ab12cd34",
        "how-to-name-things-and-why-It-Matters-In-2026-Ai",
      ].join("\n"),
    );
    expect(r.suspects).toHaveLength(0);
  });
  it("PEM 块整体替换", () => {
    const r = redactText("-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----");
    expect(r.text).toContain("[已脱敏:pem");
    expect(r.text).not.toContain("MIIabc");
  });
});

describe("三册提炼", () => {
  it("用户逐字入册、规则段按正则抽取并声明非归纳、派发入册", () => {
    const s = parseSession(dispatchFixture, "claude-code");
    const s2 = parseSession(
      ccLine({
        type: "user",
        sessionId: "bbbb2222-0000-0000-0000-000000000000",
        timestamp: "2026-08-28T10:00:00.000Z",
        message: { role: "user", content: "以后所有report都放到报告目录。\n随便聊聊天。" },
      }),
      "claude-code",
    );
    const books = buildPromptBooks([
      { session: s, file: "a.md" },
      { session: s2, file: "b.md" },
    ]);
    expect(books.counts.user).toBe(2);
    expect(books.counts.agent).toBe(1);
    expect(books.counts.rules).toBe(1);
    expect(books.userPromptsMd).toContain("派个盲审");
    expect(books.rulesMd).toContain("这是正则命中，不是归纳");
    expect(books.rulesMd).toContain("以后所有report都放到报告目录。");
    expect(books.rulesMd).not.toContain("随便聊聊天");
    expect(books.agentPromptsMd).toContain("general-purpose/opus");
  });
});

describe("grok / agy / cursor 转写解析", () => {
  it("grok：只留人打的 user_query 与助手正文，工具与后端搜索折叠，reasoning/tool_result 不入档，summary 元数据只补空缺", () => {
    const raw = [
      JSON.stringify({ type: "system", content: "You are Grok" }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_info>\nOS: windows\n</user_info>\n<rules>…</rules>" }] }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<system-reminder>skills</system-reminder>" }], synthetic_reason: "skills" }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\n盘点项目\n</user_query>" }], prompt_index: 0 }),
      JSON.stringify({ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "xxx", status: "done" }),
      JSON.stringify({
        type: "assistant",
        content: "先读说明。",
        tool_calls: [
          { id: "c1", name: "read_file", arguments: "{}" },
          { id: "c2", name: "read_file", arguments: "{}" },
        ],
        model_id: "grok-4.6",
        reasoning_effort: "high",
      }),
      JSON.stringify({ type: "tool_result", tool_call_id: "c1", content: "秘密输出不入档" }),
      JSON.stringify({ type: "backend_tool_call", kind: { tool_type: "web_search", action: { query: "q" } } }),
      JSON.stringify({ type: "assistant", content: "结论：不必接入。", model_id: "grok-4.6", reasoning_effort: "high" }),
    ].join("\n");
    expect(detectFormat(raw)).toBe("grok");
    const s = parseSession(raw, "grok", {
      meta: { id: "515c3a7b-1", cwd: "E:\\资料\\x", startedAt: "2026-09-04T18:44:50Z", endedAt: "2026-09-04T18:49:15Z", title: "GitHub 盘点", model: "grok-4.6 · 思考 high" },
    });
    expect(s.source).toBe("grok");
    expect(s.id).toBe("515c3a7b-1");
    expect(s.title).toBe("GitHub 盘点");
    expect(s.cwd).toBe("E:\\资料\\x");
    expect(s.model).toBe("grok-4.6 · 思考 high");
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "盘点项目"],
      ["assistant", "先读说明。\n\n结论：不必接入。"],
    ]);
    expect([...s.turns[1].tools.entries()]).toEqual([
      ["read_file", 2],
      ["web_search", 1],
    ]);
    const md = renderMarkdown(s);
    expect(md).toContain("- 来源: grok · id `515c3a7b-1`");
    expect(md).toContain("- 模型: grok-4.6 · 思考 high");
    expect(md).not.toContain("秘密输出");
    expect(md).not.toContain("You are Grok");
    expect(md).toContain("〔工具〕read_file ×2 · web_search");
    expect(suggestFileName(s)).toMatch(/^20260904-\d{4}-515c3a7b-GitHub-盘点\.md$/);
  });

  it("agy：USER_REQUEST 去壳、USER_SETTINGS_CHANGE 丢弃、PLANNER_RESPONSE 成轮、GENERIC 折叠为工具步骤、SYSTEM 不入档；id/cwd 来自 meta", () => {
    const raw = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-09-04T18:36:43Z",
        content: "<USER_REQUEST>\n说人话解释 MCP\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nlocale zh\n</USER_SETTINGS_CHANGE>",
      }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-09-04T18:36:50Z", content: "目录列表…" }),
      JSON.stringify({ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-04T18:37:01Z", content: "MCP 就是插座。" }),
      JSON.stringify({ step_index: 3, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-09-04T18:37:02Z", content: "server restart" }),
    ].join("\n");
    expect(detectFormat(raw)).toBe("antigravity");
    const s = parseSession(raw, "antigravity", { meta: { id: "914ef3f8-c", cwd: "E:\\资料\\y" } });
    expect(s.source).toBe("agy");
    expect(s.id).toBe("914ef3f8-c");
    expect(s.cwd).toBe("E:\\资料\\y");
    expect(s.startedAt).toBe("2026-09-04T18:36:43Z");
    expect(s.endedAt).toBe("2026-09-04T18:37:02Z");
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "说人话解释 MCP"],
      ["assistant", "MCP 就是插座。"],
    ]);
    expect([...s.turns[1].tools.entries()]).toEqual([["工具步骤", 1]]);
    expect(s.title).toBe("说人话解释 MCP");
    const md = renderMarkdown(s);
    expect(md).not.toContain("server restart");
    expect(md).not.toContain("locale zh");
  });

  it("cursor：timestamp/user_query 去壳并解析成时间，tool_use 折叠，纯 tool_result 的 user 记录与 turn_ended 不成轮；meta 补 cwd", () => {
    const raw = [
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<timestamp>Friday, Sep 4, 2026, 11:37 PM (UTC+2)</timestamp>\n<user_query>\n接手三处小修\n</user_query>" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "先读文件。" },
            { type: "tool_use", name: "Read", input: {} },
            { type: "tool_use", name: "Read", input: {} },
          ],
        },
      }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: { command: "pnpm test" } }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "输出" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "改完了。" }] } }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
    ].join("\n");
    expect(detectFormat(raw)).toBe("cursor");
    const s = parseSession(raw, "cursor", { meta: { id: "5f5ec1ea-d", cwd: "D:\\sample-app", startedAt: "2026-09-04T00:00:00.000Z" } });
    expect(s.source).toBe("cursor");
    expect(s.cwd).toBe("D:\\sample-app");
    // 文本里的时间戳能解析时优先于 meta
    expect(s.startedAt).toBe("2026-09-04T21:37:00.000Z");
    expect(s.turns[0].at).toBe("2026-09-04T21:37:00.000Z");
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "接手三处小修"],
      ["assistant", "先读文件。\n\n改完了。"],
    ]);
    expect([...s.turns[1].tools.entries()]).toEqual([
      ["Read", 2],
      ["Shell", 1],
    ]);
    expect(renderMarkdown(s)).not.toContain("<timestamp>");
  });
});

describe("归档分类（会话/导入/<项目>/）", () => {
  const win = { home: "C:\\Users\\me", tmpDir: "C:\\Users\\me\\AppData\\Local\\Temp" };
  const mac = { home: "/Users/me", tmpDir: "/var/folders/xy/T" };

  it("项目层：盘符下第一层、主目录下第一层、桌面/文档等容器再下一层；worktree 归回主仓库", () => {
    expect(projectBucket("D:\\sample-app\\apps\\web", win)).toBe("sample-app");
    expect(projectBucket("D:\\sample-app\\.claude\\worktrees\\happy-greider-514ce3", win)).toBe("sample-app");
    expect(projectBucket("C:\\Users\\me\\Desktop\\lecture-notes\\tmp", win)).toBe("lecture-notes");
    expect(projectBucket("C:\\Users\\me\\OneDrive\\Desktop\\Thesis", win)).toBe("Thesis");
    expect(projectBucket("/Users/me/code/openfile/src", mac)).toBe("openfile");
    expect(projectBucket("/Volumes/Ext/proj/a", mac)).toBe("proj");
    expect(projectBucket("D:\\steam\\steamapps\\common\\Some Game\\SomeGame_Data", win)).toBe("Some-Game");
  });

  it("git 根优先（调用方注入探测），但主目录本身是仓库时不算", () => {
    const gitRoot = (p: string) =>
      p.toLowerCase().startsWith("d:\\work\\client\\app") ? "D:\\work\\client\\app" : p.startsWith("C:\\Users\\me") ? "C:\\Users\\me" : null;
    expect(projectBucket("D:\\work\\client\\app\\src", { ...win, gitRoot })).toBe("app");
    expect(projectBucket("D:\\work\\other", { ...win, gitRoot })).toBe("work");
    expect(projectBucket("C:\\Users\\me\\Desktop\\lecture-notes", { ...win, gitRoot })).toBe("lecture-notes");
  });

  it("特殊分组：临时目录、盘符根/主目录/应用数据、没有 cwd", () => {
    expect(projectBucket("C:\\Users\\me\\AppData\\Local\\Temp\\claude\\D--x\\s\\scratchpad", win)).toBe(BUCKET_TEMP);
    expect(projectBucket("/var/folders/xy/T/run", mac)).toBe(BUCKET_TEMP);
    expect(projectBucket("/tmp/x", mac)).toBe(BUCKET_TEMP);
    expect(projectBucket("D:\\", win)).toBe(BUCKET_MISC);
    expect(projectBucket("E:", win)).toBe(BUCKET_MISC);
    expect(projectBucket("C:\\Users\\me", win)).toBe(BUCKET_MISC);
    expect(projectBucket("C:\\Users\\me\\Desktop", win)).toBe(BUCKET_MISC);
    expect(projectBucket("C:\\Users\\me\\AppData\\Local\\Packages\\Claude_x\\LocalCache", win)).toBe(BUCKET_MISC);
    expect(projectBucket("C:\\Users\\me\\Documents\\Codex\\2026-09-04\\irm-install", win)).toBe(BUCKET_MISC);
    expect(projectBucket("C:\\Users\\me\\.codex\\worktrees\\abc", win)).toBe(BUCKET_MISC);
    expect(projectBucket("/Users/me/Library/Application Support/Claude/x", mac)).toBe(BUCKET_MISC);
    expect(projectBucket(null, win)).toBe(BUCKET_UNKNOWN);
    expect(projectBucket("  ", win)).toBe(BUCKET_UNKNOWN);
  });

  it("目录名清洗：Windows 非法字符、首尾点空格、保留设备名、越界成分都洗掉", () => {
    expect(sanitizeBucket('a<b>:c"d|e?f*g')).toBe("a-b-c-d-e-f-g");
    expect(sanitizeBucket(" .hidden. ")).toBe("hidden");
    expect(sanitizeBucket("CON")).toBe("_CON");
    expect(sanitizeBucket("nul.txt")).toBe("_nul.txt");
    expect(sanitizeBucket("..")).toBe("");
    expect(sanitizeBucket("x".repeat(80))).toHaveLength(60);
    expect(projectBucket("D:\\..\\..", win)).toBe(BUCKET_MISC);
  });

  it("标题：跳过注入块", () => {
    const codex = (texts: string[], cwd = "/w") =>
      [
        JSON.stringify({ type: "session_meta", timestamp: "2026-10-01T08:00:00Z", payload: { id: "c1", cwd } }),
        ...texts.map((text) =>
          JSON.stringify({ type: "response_item", timestamp: "2026-10-01T08:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
        ),
      ].join("\n");
    expect(parseSession(codex(["<environment_context>\n<cwd>/w</cwd>", "复习计算机网络"]), "codex").title).toBe("复习计算机网络");
    expect(parseSession(codex(["# AGENTS.md instructions for D:\\x\n...", "修登录"]), "codex").title).toBe("修登录");
  });

  it("codex 压缩记录：正文里没有的用户原话补在开头（带会话开始时间），注入块与已有消息不重复补，普通消息照旧逐字", () => {
    const raw = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-14T09:40:31Z", payload: { id: "sub1", cwd: "/w", agent_path: "/root/luna" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-14T09:40:36Z",
        payload: { type: "agent_message", author: "/root", recipient: "/root/luna", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/luna" }] },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-14T09:41:00Z",
        payload: { type: "agent_message", author: "/root/luna", recipient: "/root", content: [{ type: "input_text", text: "回报" }] },
      }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-14T09:42:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "开始干活" }] } }),
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-07-14T10:00:00Z",
        payload: {
          replacement_history: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<current_date>2026-07-14</current_date>" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "实现前要谨慎确认影响面" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "开始干活" }] },
          ],
        },
      }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-14T10:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-14T10:02:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] } }),
    ].join("\n");
    const s = parseSession(raw, "codex");
    expect(s.turns.map((t) => [t.role, t.text.split("\n")[0]])).toEqual([
      ["user", "实现前要谨慎确认影响面"],
      ["user", "〔/root 下发的任务〕"],
      ["assistant", "开始干活"],
      ["user", "继续"],
      ["user", "继续"],
    ]);
    expect(s.turns[0].at).toBe("2026-07-14T09:40:31Z");
  });

  it("档案校验行：原样 → true，CRLF 换行不算改动，正文改一个字 → false，没有校验行 → null", () => {
    const md = "# 会话：x\n\n- 来源: codex · id `a`\n- 导入: 2026-10-09 10:00 · 原始转写: `/p`\n\n---\n\n## 用户\n\n正文\n";
    const sealed = withChecksum(md);
    expect(sealed).toMatch(/^- 导入: .*\n- 校验: sha256:[0-9a-f]{16}\n/m);
    expect(archiveUntouched(sealed)).toBe(true);
    expect(archiveUntouched(sealed.replace(/\n/g, "\r\n"))).toBe(true);
    expect(archiveUntouched(sealed.replace("正文", "改文"))).toBe(false);
    expect(archiveUntouched(md)).toBeNull();
    expect(archiveChecksum(sealed)).toBe(archiveChecksum(md));
  });
});
