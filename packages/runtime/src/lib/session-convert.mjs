/**
 * 会话转写 → 可读 md 的导入内核（纯函数、零 IO；CLI 在 scripts/session-import.mjs）。
 *
 * 契约：
 *  - 用户消息逐字保留，不转述不截断；
 *  - 助手消息只保留正文文本；普通工具调用折叠成一行清点；思考与工具输出不入档；
 *  - 子代理派发（Agent/Task）例外：提示词全文 + 最终答复（截断）单独保留——派发即指令资产；
 *  - 认不出的行宁可丢弃也不猜测——导入物是档案，不是重建。
 *
 * 提炼层：
 *  - USER_PROMPTS：用户消息逐字汇编，零过滤；
 *  - AGENT_PROMPTS：子代理派发提示词汇编；
 *  - USER_RULES：正则命中的规则段抽取——是正则命中，不是归纳，成立与否由人判断；
 *  - fork 检测：用户消息 hash 集合的包含关系，只标注不删除。
 *
 * 脱敏（redactText）：白名单模式替换 + 关键词行高熵替换 + 疑似清单（只报告不替换）。
 * 白名单永远会漏——疑似清单必须人过目后才推远端。
 */
import crypto from "node:crypto";
import path from "node:path";

/** @typedef {{role:"user"|"assistant", at:string|null, text:string, tools:Map<string,number>, agents:AgentDispatch[]}} Turn */
/** @typedef {{id:string|null, description:string, subagentType:string, model:string, prompt:string, reply:string|null}} AgentDispatch */

const CC_SKIP_TYPES = new Set([
  "attachment",
  "last-prompt",
  "atis-latch",
  "bridge-session",
  "queue-operation",
  "mode",
  "frame-link",
  "system",
  "summary",
  "ai-title",
  "custom-title",
]);

const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);
const AGENT_REPLY_CAP = 12000;
const AGENT_PROMPT_CAP = 20000;

/** 斜杠命令展开、本地命令回显等 harness 噪声（不是人打的字） */
const CC_NOISE_RE = /^\s*(<command-name>|<local-command-stdout>|<local-command-stderr>|Caveat: )/;
/** 整条消息只是一段注入的系统提醒时跳过；混排时按逐字原则整条保留 */
const REMINDER_ONLY_RE = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;

/** 规则段标记（抽取=正则命中，非归纳；词表来自真实语料实测） */
const RULE_MARK_RE =
  /禁用|不要|不许|不能|必须|一律|永远|记住|以后|红线|规则|注意|别再|不允许|只能|千万|恒定|默认|优先级|口径|不得|切记|务必|返工/;

const lines = (raw) => raw.split(/\r?\n/).filter((l) => l.trim() !== "");

const parseJson = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

/** @param {string} raw @returns {"claude-code"|"codex"|"gemini-history"|"grok"|"antigravity"|"cursor"|"generic-jsonl"|"generic-json"|null} */
export function detectFormat(raw) {
  const t = raw.trimStart();
  if (t === "") return null;
  if (t.startsWith("{") && !t.includes("\n{")) {
    const obj = parseJson(raw.trim());
    if (obj && Array.isArray(obj.history)) return "gemini-history";
    if (obj && (Array.isArray(obj.messages) || Array.isArray(obj.chat) || Array.isArray(obj.turns)))
      return "generic-json";
  }
  const sample = lines(raw).slice(0, 50).map(parseJson).filter(Boolean);
  if (sample.length === 0) return null;
  if (sample.some((o) => o.sessionId && (o.type === "user" || o.type === "assistant" || o.aiTitle || o.customTitle)))
    return "claude-code";
  if (sample.some((o) => o.type === "session_meta" || o.type === "response_item" || o.type === "event_msg"))
    return "codex";
  if (
    sample.some(
      (o) =>
        o.type === "backend_tool_call" ||
        (o.type === "tool_result" && o.tool_call_id) ||
        (o.type === "assistant" && o.model_id) ||
        (o.type === "reasoning" && o.encrypted_content),
    )
  )
    return "grok";
  if (sample.some((o) => typeof o.step_index === "number" && typeof o.source === "string" && typeof o.type === "string"))
    return "antigravity";
  if (
    sample.some(
      (o) =>
        o.type === "turn_ended" ||
        (o.role && Array.isArray(o.message?.content) && o.message.content.some((p) => p?.type === "tool_use")),
    )
  )
    return "cursor";
  if (sample.some((o) => o.role || o.type === "message")) return "generic-jsonl";
  return null;
}

const newTurn = (role, at) => ({ role, at: at ?? null, text: "", tools: new Map(), agents: [] });

const pushText = (turn, text) => {
  if (!text) return;
  turn.text = turn.text === "" ? text : `${turn.text}\n\n${text}`;
};

const tallyTool = (turn, name) => {
  if (!name) return;
  turn.tools.set(name, (turn.tools.get(name) ?? 0) + 1);
};

/** content 为 string 或 content block 数组时抽出纯文本（text 块拼接） */
const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n\n");
  return "";
};

/**
 * 主控自身的令牌用量累加。
 *
 * 口径：`新处理 = 输入 + 输出 + 缓存创建`，**缓存读单列**。
 * 为什么不把缓存读加进主数字：它每一轮都把整段上下文重新计一遍，
 * 一个长会话能滚到几千万，那不是「烧掉的算力」，是被重复计价的同一段上下文。
 * 两个数都留着，UI 上主数字是新处理，缓存读放 title 里。
 * @param {{fresh:number, cached:number}} acc @param {unknown} usage
 */
function addUsage(acc, usage) {
  if (!usage || typeof usage !== "object") return acc;
  const u = /** @type {Record<string, unknown>} */ (usage);
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  acc.fresh += n(u.input_tokens) + n(u.output_tokens) + n(u.cache_creation_input_tokens);
  acc.cached += n(u.cache_read_input_tokens);
  return acc;
}

const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…（截断，原长 ${s.length} 字符）` : s);

/** @param {string} raw @param {{sidechains?:boolean}} [opts] */
function parseClaudeCode(raw, opts = {}) {
  const turns = [];
  let title = null;
  let aiTitle = null;
  let id = null;
  let cwd = null;
  let branch = null;
  let startedAt = null;
  let endedAt = null;
  /** @type {Map<string, AgentDispatch>} 派发 id → 记录（用于把 tool_result 里的答复缝回去） */
  const dispatches = new Map();
  const usage = { fresh: 0, cached: 0 };

  for (const l of lines(raw)) {
    const o = parseJson(l);
    if (!o || typeof o.type !== "string") continue;
    if (o.customTitle) title = String(o.customTitle);
    if (o.aiTitle) aiTitle = String(o.aiTitle);
    if (CC_SKIP_TYPES.has(o.type)) continue;
    if (o.isSidechain === true && !opts.sidechains) continue;
    if (o.timestamp) {
      startedAt ??= o.timestamp;
      endedAt = o.timestamp;
    }
    id ??= o.sessionId ?? null;

    if (o.type === "user") {
      if (o.isMeta === true) continue;
      cwd ??= o.cwd ?? null;
      branch ??= o.gitBranch ?? null;
      const content = o.message?.content;
      // 工具输出走 user 行回传：不是人说的话，不成轮；但派发答复要缝回对应 dispatch
      if (Array.isArray(content) && content.every((b) => b?.type === "tool_result")) {
        for (const b of content) {
          const d = b.tool_use_id ? dispatches.get(b.tool_use_id) : null;
          if (d && d.reply === null) {
            const replyText = typeof b.content === "string" ? b.content : textOf(b.content);
            if (replyText) d.reply = cap(replyText, AGENT_REPLY_CAP);
          }
        }
        continue;
      }
      const text = textOf(content);
      if (text === "" || CC_NOISE_RE.test(text) || REMINDER_ONLY_RE.test(text)) continue;
      const t = newTurn("user", o.timestamp);
      t.text = text; // 逐字：user 侧不做任何加工
      turns.push(t);
      continue;
    }

    if (o.type === "assistant") {
      addUsage(usage, o.message?.usage);
      const content = o.message?.content;
      if (!Array.isArray(content)) continue;
      const last = turns[turns.length - 1];
      const turn = last && last.role === "assistant" ? last : newTurn("assistant", o.timestamp);
      if (turn !== last) turns.push(turn);
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text") pushText(turn, b.text);
        else if (b.type === "tool_use") {
          if (AGENT_TOOL_NAMES.has(b.name)) {
            const inp = b.input ?? {};
            const d = {
              id: b.id ?? null,
              description: String(inp.description ?? ""),
              subagentType: String(inp.subagent_type ?? inp.subagentType ?? "general-purpose"),
              model: String(inp.model ?? "inherit"),
              prompt: cap(String(inp.prompt ?? ""), AGENT_PROMPT_CAP),
              reply: null,
            };
            turn.agents.push(d);
            if (d.id) dispatches.set(d.id, d);
          } else tallyTool(turn, b.name);
        }
        // thinking / 其它块型不入档
      }
    }
  }

  return { source: "claude-code", id, title: title ?? aiTitle, cwd, branch, startedAt, endedAt, model: null, turns, usage };
}

/** codex rollout：response_item/message 优先；一条都没有时用 event_msg 兜底 */
function parseCodex(raw) {
  const items = [];
  const events = [];
  let id = null;
  let cwd = null;
  let agentPath = null;
  let startedAt = null;
  let endedAt = null;
  const contentText = (content) =>
    Array.isArray(content) ? content.map((c) => c?.text ?? "").filter(Boolean).join("\n\n") : textOf(content);
  // 压缩记录（compacted.replacement_history）重述压缩前的历史。新版 codex 会改写旧 rollout、分叉出的子 agent
  // 也只在这里带着父会话的用户原话——正文里没有的才补，补在开头（它们早于本文件余下的记录）。
  const msgKey = (role, text) => `${role}\u0000${md5(text)}`;
  const seen = new Set();
  const carried = [];
  const pushMsg = (role, at, text) => {
    seen.add(msgKey(role, text));
    items.push({ role, at, text });
  };

  for (const l of lines(raw)) {
    const o = parseJson(l);
    if (!o) continue;
    if (o.timestamp) {
      startedAt ??= o.timestamp;
      endedAt = o.timestamp;
    }
    const p = o.payload ?? o;
    if (o.type === "session_meta" || p.type === "session_meta") {
      const meta = p.payload ?? p;
      id ??= meta.id ?? null;
      cwd ??= meta.cwd ?? null;
      agentPath ??= meta.agent_path ?? null;
      continue;
    }
    if (o.type === "compacted" && Array.isArray(p.replacement_history)) {
      for (const m of p.replacement_history) {
        if (m?.type !== "message" || (m.role !== "user" && m.role !== "assistant")) continue;
        const text = contentText(m.content);
        // 注入的环境块每次重述都带当时的日期等，比不出重复；它们本来也不是人打的字，只补真正的消息
        if (text && !INJECTED_USER_RE.test(text)) carried.push({ role: m.role, at: null, text });
      }
      continue;
    }
    if (o.type === "response_item" || p.type === "message" || p.type === "function_call") {
      const m = o.type === "response_item" ? p : o;
      if (m.type === "message" && (m.role === "user" || m.role === "assistant")) {
        const text = contentText(m.content);
        if (text) pushMsg(m.role, o.timestamp ?? null, text);
      } else if (m.type === "function_call") {
        items.push({ role: "assistant", at: o.timestamp ?? null, tool: m.name ?? "tool" });
      } else if (m.type === "agent_message") {
        // 多 agent 模式：父 agent 下发给本会话的新任务就是本会话的「提示词」，逐字留；其余 agent 间消息只清点
        const text = contentText(m.content);
        if (text && agentPath && m.recipient === agentPath && /^Message Type: NEW_TASK\b/.test(text)) {
          pushMsg("user", o.timestamp ?? null, `〔${m.author ?? "父 agent"} 下发的任务〕\n${text}`);
        }
      }
      continue;
    }
    if (o.type === "event_msg") {
      if (p.type === "user_message" && p.message) events.push({ role: "user", at: o.timestamp ?? null, text: String(p.message) });
      if (p.type === "agent_message" && p.message) events.push({ role: "assistant", at: o.timestamp ?? null, text: String(p.message) });
    }
  }

  const head = [];
  for (const c of carried) {
    const k = msgKey(c.role, c.text);
    if (seen.has(k)) continue;
    seen.add(k);
    head.push({ ...c, at: startedAt });
  }
  const seq = items.length > 0 || head.length > 0 ? [...head, ...items] : events;
  const turns = [];
  for (const it of seq) {
    const last = turns[turns.length - 1];
    if (it.role === "assistant" && last && last.role === "assistant") {
      if (it.tool) tallyTool(last, it.tool);
      else pushText(last, it.text);
      continue;
    }
    const t = newTurn(it.role, it.at);
    if (it.tool) tallyTool(t, it.tool);
    else t.text = it.text ?? "";
    turns.push(t);
  }
  return { source: "codex", id, title: null, cwd, branch: null, startedAt, endedAt, model: null, turns };
}

function parseGeminiHistory(raw) {
  const obj = parseJson(raw.trim());
  const hist = Array.isArray(obj?.history) ? obj.history : [];
  const turns = [];
  for (const h of hist) {
    const role = h?.role === "user" ? "user" : h?.role === "model" ? "assistant" : null;
    if (!role) continue;
    const text = Array.isArray(h.parts)
      ? h.parts.map((p) => p?.text ?? "").filter(Boolean).join("\n\n")
      : textOf(h.parts);
    if (text === "") continue;
    const t = newTurn(role, null);
    t.text = text;
    turns.push(t);
  }
  return { source: "gemini", id: obj?.sessionId ?? null, title: null, cwd: null, branch: null, startedAt: null, endedAt: null, model: null, turns };
}

// ── grok / antigravity / cursor（各家本地转写都能导进文库）────────────

/** 只取 <tag>…</tag> 里的内容；没有标签就原样返回 */
const insideTag = (text, tag) => {
  const m = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text);
  return m ? m[1] : text;
};
/** 整块丢掉 <tag>…</tag>（harness 注入的设置变更之类，不是人打的字） */
const dropBlocks = (text, tag) => text.replace(new RegExp(`\\s*<${tag}>[\\s\\S]*?</${tag}>\\s*`, "g"), "\n").trim();

/** 当前末尾是助手轮就续写，否则新开一轮（各家都把工具调用拆成多条记录） */
const assistantTurn = (turns, at) => {
  const last = turns[turns.length - 1];
  if (last && last.role === "assistant") return last;
  const t = newTurn("assistant", at);
  turns.push(t);
  return t;
};

/**
 * Grok Build：~/.grok/sessions/<cwd 百分号编码>/<id>/chat_history.jsonl。
 * 记录：system（提示词）/ user（content 块；synthetic_reason = harness 注入；prompt_index = 人打的）/
 * reasoning（加密，不入档）/ assistant（content 字符串 + tool_calls）/ tool_result（不入档）/ backend_tool_call（web_search 等）。
 * 没有时间戳：起止、标题、模型在旁边的 summary.json，由导入器作 meta 传入。
 */
function parseGrok(raw) {
  const turns = [];
  for (const l of lines(raw)) {
    const o = parseJson(l);
    if (!o || typeof o.type !== "string") continue;
    if (o.type === "user") {
      if (o.synthetic_reason) continue;
      const text = textOf(o.content).trim();
      if (!text || /^<(user_info|system-reminder|rules)>/.test(text)) continue;
      const t = newTurn("user", null);
      t.text = insideTag(text, "user_query").trim();
      turns.push(t);
      continue;
    }
    if (o.type === "assistant") {
      const t = assistantTurn(turns, null);
      pushText(t, (typeof o.content === "string" ? o.content : textOf(o.content)).trim());
      for (const c of Array.isArray(o.tool_calls) ? o.tool_calls : []) tallyTool(t, c?.name ?? "tool");
      continue;
    }
    if (o.type === "backend_tool_call") tallyTool(assistantTurn(turns, null), o.kind?.tool_type ?? "backend_tool");
    // system / reasoning / tool_result：不入档
  }
  return { source: "grok", id: null, title: null, cwd: null, branch: null, startedAt: null, endedAt: null, model: null, turns };
}

/**
 * Antigravity CLI（agy）：~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl。
 * 记录 {step_index, source, type, status, created_at, content}：USER_EXPLICIT/USER_INPUT（<USER_REQUEST> 壳）、
 * MODEL/PLANNER_RESPONSE（正文）、MODEL/GENERIC（工具步骤输出，只计数）、SYSTEM/*（不入档）。
 * 会话 id = 目录名，cwd 在 cache/last_conversations.json，由导入器作 meta 传入。
 */
function parseAntigravity(raw) {
  const turns = [];
  let startedAt = null;
  let endedAt = null;
  for (const l of lines(raw)) {
    const o = parseJson(l);
    if (!o || typeof o.type !== "string") continue;
    const at = typeof o.created_at === "string" ? o.created_at : null;
    if (at) {
      startedAt ??= at;
      endedAt = at;
    }
    if (o.source === "USER_EXPLICIT" || o.type === "USER_INPUT") {
      let text = typeof o.content === "string" ? o.content : textOf(o.content);
      text = dropBlocks(text, "USER_SETTINGS_CHANGE");
      text = insideTag(text, "USER_REQUEST").trim();
      if (!text) continue;
      const t = newTurn("user", at);
      t.text = text;
      turns.push(t);
      continue;
    }
    if (o.source === "MODEL") {
      const t = assistantTurn(turns, at);
      if (o.type === "PLANNER_RESPONSE") pushText(t, String(o.content ?? "").trim());
      else tallyTool(t, o.type === "GENERIC" ? "工具步骤" : String(o.type).toLowerCase());
    }
    // SYSTEM：不入档
  }
  return { source: "agy", id: null, title: null, cwd: null, branch: null, startedAt, endedAt, model: null, turns };
}

/** cursor 用户消息开头的 <timestamp>Friday, Sep 4, 2026, 11:37 PM (UTC+2)</timestamp> */
const CURSOR_TS_RE =
  /<timestamp>\s*(?:[A-Za-z]+,\s*)?([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}),?\s*(\d{1,2}:\d{2}\s*[AP]M)?(?:\s*\(UTC([+-]\d{1,2})(?::?(\d{2}))?\))?\s*<\/timestamp>/i;
function cursorStamp(text) {
  const m = CURSOR_TS_RE.exec(text);
  if (!m) return null;
  const tz = m[3]
    ? `GMT${m[3].startsWith("-") ? "-" : "+"}${String(Math.abs(Number(m[3]))).padStart(2, "0")}${m[4] ?? "00"}`
    : "";
  const d = new Date(`${m[1]} ${m[2] ?? "12:00 AM"} ${tz}`.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Cursor Agent CLI：~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl。
 * 记录 {role, message:{content:[text|tool_use|tool_result]}} 与 {type:"turn_ended"}；用户文本带 <timestamp> 与 <user_query> 壳。
 * cwd 与起止毫秒在 ~/.cursor/chats/<hash>/<id>/meta.json，由导入器作 meta 传入（文本里的时间戳能解析时优先）。
 */
function parseCursor(raw) {
  const turns = [];
  let startedAt = null;
  let endedAt = null;
  for (const l of lines(raw)) {
    const o = parseJson(l);
    if (!o || !o.role || !o.message) continue;
    const parts = Array.isArray(o.message.content) ? o.message.content : [];
    if (o.role === "user") {
      const rawText = textOf(o.message.content);
      const at = cursorStamp(rawText);
      if (at) {
        startedAt ??= at;
        endedAt = at;
      }
      const text = insideTag(rawText.replace(CURSOR_TS_RE, ""), "user_query").trim();
      if (!text) continue; // 纯 tool_result 的 user 记录不成轮
      const t = newTurn("user", at);
      t.text = text;
      turns.push(t);
      continue;
    }
    if (o.role === "assistant") {
      const t = assistantTurn(turns, null);
      pushText(t, textOf(parts).trim());
      for (const p of parts) if (p?.type === "tool_use") tallyTool(t, p.name ?? "tool");
    }
  }
  return { source: "cursor", id: null, title: null, cwd: null, branch: null, startedAt, endedAt, model: null, turns };
}

const GENERIC_USER = new Set(["user", "human"]);
const GENERIC_ASSISTANT = new Set(["assistant", "ai", "model", "agent"]);

function genericTurn(o) {
  const roleRaw = String(o.role ?? o.type ?? "").toLowerCase();
  const role = GENERIC_USER.has(roleRaw) ? "user" : GENERIC_ASSISTANT.has(roleRaw) ? "assistant" : null;
  if (!role) return null;
  const text =
    textOf(o.content) ||
    (typeof o.text === "string" ? o.text : "") ||
    (typeof o.message === "string" ? o.message : textOf(o.message?.content));
  if (!text) return null;
  const t = newTurn(role, o.timestamp ?? o.ts ?? null);
  t.text = text;
  return t;
}

function parseGeneric(raw, format) {
  let records;
  if (format === "generic-json") {
    const obj = parseJson(raw.trim()) ?? {};
    records = obj.messages ?? obj.chat ?? obj.turns ?? obj.history ?? [];
  } else {
    records = lines(raw).map(parseJson).filter(Boolean);
  }
  const turns = [];
  for (const o of records) {
    const t = genericTurn(o);
    if (t) turns.push(t);
  }
  return { source: "generic", id: null, title: null, cwd: null, branch: null, startedAt: null, endedAt: null, model: null, turns };
}

/**
 * @param {string} raw @param {string} format
 * @param {{sidechains?:boolean, meta?:{id?:string|null,title?:string|null,cwd?:string|null,branch?:string|null,startedAt?:string|null,endedAt?:string|null,model?:string|null}}} [opts]
 *   meta：转写文件本身缺的字段（各家把时间 / 标题 / 项目放在旁边的 summary.json / meta.json 里），只补空缺不覆盖
 */
export function parseSession(raw, format, opts = {}) {
  const s =
    format === "claude-code"
      ? parseClaudeCode(raw, opts)
      : format === "codex"
        ? parseCodex(raw)
        : format === "gemini-history"
          ? parseGeminiHistory(raw)
          : format === "grok"
            ? parseGrok(raw)
            : format === "antigravity"
              ? parseAntigravity(raw)
              : format === "cursor"
                ? parseCursor(raw)
                : parseGeneric(raw, format);
  const m = opts.meta ?? {};
  for (const k of ["id", "title", "cwd", "branch", "startedAt", "endedAt", "model"]) {
    if ((s[k] === null || s[k] === undefined) && m[k]) s[k] = m[k];
  }
  if (!s.title) s.title = titleFromTurns(s.turns);
  // fork 检测素材：用户消息 hash 集合（集合包含 ⇒ 疑似 fork/子集，只标注不删）
  s.userHashes = new Set(s.turns.filter((t) => t.role === "user").map((t) => md5(t.text)));
  return s;
}

/** 注入的上下文块（不是人打的字）：codex 的 <environment_context>、AGENTS.md 指令等——取标题时跳过，正文照留 */
const INJECTED_USER_RE = /^\s*(<(environment_context|user_instructions|permissions[^>]*|system-reminder|INSTRUCTIONS)>|# AGENTS\.md instructions for )/i;

/** 没有现成标题时从用户消息取：跳过注入块 */
function titleFromTurns(turns) {
  const users = turns.filter((t) => t.role === "user");
  const real = users.find((t) => !INJECTED_USER_RE.test(t.text)) ?? users[0];
  if (!real) return "未命名会话";
  return real.text.trim().split("\n")[0].slice(0, 40);
}

/** A ⊊ B ⇒ A 疑似是 B 的 fork/子集（用户消息 hash 集合的真包含判据） */
export function isSubsetSession(a, b) {
  if (a.userHashes.size === 0 || a.userHashes.size >= b.userHashes.size) return false;
  for (const h of a.userHashes) if (!b.userHashes.has(h)) return false;
  return true;
}

const fmtStamp = (iso) => {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmtShort = (iso) => (fmtStamp(iso) === "?" ? "" : ` · ${fmtStamp(iso).slice(5)}`);

/** @param {ReturnType<typeof parseSession>} s @param {{importedAt?:string, originPath?:string, extraHeader?:string[]}} [opts] */
export function renderMarkdown(s, opts = {}) {
  const users = s.turns.filter((t) => t.role === "user").length;
  const assistants = s.turns.length - users;
  let toolTotal = 0;
  let dispatchTotal = 0;
  for (const t of s.turns) {
    for (const c of t.tools.values()) toolTotal += c;
    dispatchTotal += t.agents.length;
  }

  const head = [
    `# 会话：${s.title}`,
    "",
    `- 来源: ${s.source}${s.id ? ` · id \`${s.id}\`` : ""}`,
    ...(s.cwd ? [`- 项目: ${s.cwd}${s.branch ? `（分支 ${s.branch}）` : ""}`] : []),
    ...(s.model ? [`- 模型: ${s.model}`] : []),
    `- 时间: ${fmtStamp(s.startedAt)} → ${fmtStamp(s.endedAt)} · 轮次: ${users} 用户 / ${assistants} 助手 · 工具 ${toolTotal} 次 · 派发 ${dispatchTotal} 次`,
    ...(s.usage && s.usage.fresh > 0
      ? [`- 主控用量: ${s.usage.fresh} tokens（新处理 = 输入+输出+缓存创建；另有缓存读 ${s.usage.cached}，每轮重复计不入主数）`]
      : []),
    ...(opts.importedAt ? [`- 导入: ${opts.importedAt}${opts.originPath ? ` · 原始转写: \`${opts.originPath}\`` : ""}`] : []),
    ...(opts.extraHeader ?? []).map((l) => `- ${l}`),
    "",
    "> 由 session-import 导入。用户消息逐字保留；助手保留正文、折叠工具调用；子代理派发保留提示词与答复（截断）；思考与工具输出不入档。",
    "",
    "---",
  ];

  const body = [];
  for (const t of s.turns) {
    body.push("", `## ${t.role === "user" ? "用户" : "助手"}${fmtShort(t.at)}`, "");
    if (t.text !== "") body.push(t.text);
    for (const d of t.agents) {
      body.push(
        "",
        `> 〔派发〕${d.subagentType}/${d.model}${d.description ? ` · ${d.description}` : ""}`,
        "",
        "<details><summary>派发提示词与答复</summary>",
        "",
        "```text",
        d.prompt.replaceAll("```", "ˋˋˋ"),
        "```",
        ...(d.reply ? ["", "答复：", "", "```text", d.reply.replaceAll("```", "ˋˋˋ"), "```"] : []),
        "",
        "</details>",
      );
    }
    if (t.tools.size > 0) {
      const parts = [...t.tools.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
      body.push("", `> 〔工具〕${parts.join(" · ")}`);
    }
  }
  return `${[...head, ...body].join("\n")}\n`;
}

/** 与 tasks.ts 的 taskFileName 同口径的文件名（可排序 + id 前缀保证幂等） */
export function suggestFileName(s) {
  const d = s.startedAt ? new Date(s.startedAt) : null;
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    d && !Number.isNaN(d.getTime())
      ? `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
      : "00000000-0000";
  const id8 = (s.id ?? "").replace(/[^0-9a-zA-Z]/g, "").slice(0, 8) || "noid";
  const slug = (s.title ?? "")
    .replace(/[\\/:*?"<>|#\s.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${stamp}-${id8}${slug ? `-${slug}` : ""}.md`;
}

// ── 分类：会话/导入/<项目>/ ─────────────────────────────────────────────

/** 特殊分组（目录名是数据串，永不翻译；下划线前缀让它们与真实项目分开排） */
export const BUCKET_UNKNOWN = "_未知项目";
export const BUCKET_TEMP = "_临时";
export const BUCKET_MISC = "_杂项";

/** 用户目录下装项目的「容器目录」：项目名取它下一层 */
const HOME_CONTAINERS = new Set(["desktop", "documents", "downloads", "桌面", "文档", "下载", "onedrive", "source", "repos", "projects", "code", "dev", "workspace", "work", "github"]);
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** 目录名清洗：去掉 Windows 非法字符与首尾点/空格、避开保留名、限长；清空了返回 "" */
export function sanitizeBucket(name) {
  let s = String(name ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 60)
    .replace(/[.\s-]+$/g, "");
  if (WIN_RESERVED_RE.test(s)) s = `_${s}`;
  return s;
}

/**
 * 会话 cwd → 归档分组名。纯函数：git 根探测由调用方注入（ctx.gitRoot，拿不到返回 null）。
 *  - agent 的 worktree（<仓库>/.claude|.codex|.cursor/worktrees/<名>）→ 归回主仓库；
 *  - 临时目录（%TEMP%、/tmp、/var/folders、ctx.tmpDir 之下）→ _临时；
 *  - 应用数据目录、盘符根、用户主目录与桌面/文档本身、Codex 桌面版的日期对话目录 → _杂项；
 *  - 其余：git 根的目录名；探测不到时取「项目层」——盘符下第一层，或用户目录下第一层（桌面/文档等容器再下一层）。
 * @param {string|null|undefined} cwd
 * @param {{home?:string, tmpDir?:string, gitRoot?:(p:string)=>string|null}} [ctx]
 */
export function projectBucket(cwd, ctx = {}) {
  if (typeof cwd !== "string" || !cwd.trim()) return BUCKET_UNKNOWN;
  const raw = cwd.trim();
  if (/^[A-Za-z]:\.?$/.test(raw)) return BUCKET_MISC; // 裸盘符（path.win32.normalize 会把 "E:" 变成 "E:."）
  const win = /^[A-Za-z]:([\\/]|$)/.test(raw) || raw.startsWith("\\\\");
  const P = win ? path.win32 : path.posix;
  let p = P.normalize(raw);
  if (p.length > P.parse(p).root.length) p = p.replace(/[\\/]+$/, "");
  const key = (x) => (win ? P.normalize(x).replace(/[\\/]+$/, "").toLowerCase() : P.normalize(x).replace(/\/+$/, ""));
  const inside = (child, parent) => {
    if (!parent) return false;
    const c = key(child);
    const q = key(parent);
    return c === q || c.startsWith(q + P.sep);
  };

  const wt = /^(.+?)[\\/]\.(?:claude|codex|cursor)[\\/]worktrees([\\/]|$)/i.exec(p);
  if (wt) p = wt[1];
  if (
    /[\\/]AppData[\\/]Local[\\/]Temp([\\/]|$)/i.test(p) ||
    /^\/(tmp|private\/tmp|var\/folders|private\/var\/folders)(\/|$)/.test(p) ||
    (ctx.tmpDir && inside(p, ctx.tmpDir))
  )
    return BUCKET_TEMP;
  if (/[\\/]AppData[\\/]/i.test(p) || /\/Library\/(Application Support|Containers|Group Containers)\//.test(p)) return BUCKET_MISC;
  if (/[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}([\\/]|$)/i.test(p)) return BUCKET_MISC;
  const game = /[\\/]steamapps[\\/]common[\\/]([^\\/]+)/i.exec(p); // 游戏 mod / 汉化：按游戏分
  if (game) return sanitizeBucket(game[1]) || BUCKET_UNKNOWN;

  const rootLen = P.parse(p).root.length;
  if (p.length <= rootLen) return BUCKET_MISC; // 盘符根 / 文件系统根
  const home = ctx.home ? P.normalize(ctx.home) : null;
  let rest = null; // 「项目层」以下的相对段
  if (home && inside(p, home)) {
    rest = key(p) === key(home) ? [] : P.relative(home, p).split(/[\\/]/).filter(Boolean);
    if (rest.length === 0) return BUCKET_MISC;
    if (HOME_CONTAINERS.has(rest[0].toLowerCase())) {
      rest = rest.slice(1);
      if (rest.length > 0 && HOME_CONTAINERS.has(rest[0].toLowerCase())) rest = rest.slice(1); // OneDrive/Desktop/<项目>
      if (rest.length === 0) return BUCKET_MISC;
    }
    if (rest[0].startsWith(".")) return BUCKET_MISC; // ~/.codex、~/.config 之类的工具目录
  }

  const git = ctx.gitRoot ? ctx.gitRoot(p) : null;
  if (git && !(home && key(git) === key(home)) && P.parse(git).root.length < git.length) {
    return sanitizeBucket(P.basename(git)) || BUCKET_UNKNOWN;
  }
  if (rest) return sanitizeBucket(rest[0]) || BUCKET_UNKNOWN;
  // 盘符下第一层；macOS 外置卷 /Volumes/<盘>/<项目>；Linux /home/<用户>/<项目> 由 ctx.home 覆盖
  const segs = p.slice(rootLen).split(/[\\/]/).filter(Boolean);
  if (!win && segs[0] === "Volumes" && segs.length >= 3) return sanitizeBucket(segs[2]) || BUCKET_UNKNOWN;
  if (!win && (segs[0] === "Users" || segs[0] === "home") && segs.length >= 3) return sanitizeBucket(segs[2]) || BUCKET_UNKNOWN;
  return sanitizeBucket(segs[0]) || BUCKET_UNKNOWN;
}

/** 档案正文完整性：去掉「校验」行后的 sha256 前 16 位（判断档案自导入后有没有被人改过） */
const CHECKSUM_LINE_RE = /^- 校验: sha256:[0-9a-f]{16}\n/m;
export function archiveChecksum(md) {
  const text = md.replace(/\r\n/g, "\n").replace(CHECKSUM_LINE_RE, "");
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
/** 给渲染好的档案头插一行校验（插在「导入」行之后；没有就插在标题块末尾） */
export function withChecksum(md) {
  const sum = archiveChecksum(md);
  const line = `- 校验: sha256:${sum}\n`;
  const m = /^- 导入: .*\n/m.exec(md);
  if (m) return md.slice(0, m.index + m[0].length) + line + md.slice(m.index + m[0].length);
  const blank = md.indexOf("\n\n", md.indexOf("\n- "));
  return blank === -1 ? md + line : md.slice(0, blank + 1) + line + md.slice(blank + 1);
}
/** 档案是否仍是导入时的原样：true / false / null（没有校验行） */
export function archiveUntouched(md) {
  const m = /^- 校验: sha256:([0-9a-f]{16})\r?$/m.exec(md);
  if (!m) return null;
  return archiveChecksum(md) === m[1];
}

// ── 提炼层：三册 _prompts ────────────────────────────────────────────────

/** @param {{session:ReturnType<typeof parseSession>, file:string}[]} entries */
export function buildPromptBooks(entries) {
  const user = [];
  const agent = [];
  const rules = [];
  const seenRule = new Set();

  for (const { session: s, file } of entries) {
    const link = `\`${(s.id ?? "").slice(0, 8) || "noid"}\` → [${file}](../${file})`;
    for (const t of s.turns) {
      if (t.role === "user" && t.text !== "") {
        user.push(`### ${fmtStamp(t.at)} · ${s.title}\n\n${link}\n\n${t.text}\n\n---`);
        for (const para of t.text.split(/\n+/)) {
          const p = para.trim();
          if (p.length > 6 && RULE_MARK_RE.test(p)) {
            const key = `${s.id}\0${p}`;
            if (!seenRule.has(key)) {
              seenRule.add(key);
              rules.push({ para: p, title: s.title, link });
            }
          }
        }
      }
      for (const d of t.agents) {
        agent.push(
          `### ${fmtStamp(t.at)} · ${d.subagentType}/${d.model}${d.description ? ` · ${d.description}` : ""}\n\n${link}\n\n\`\`\`text\n${d.prompt.replaceAll("```", "ˋˋˋ")}\n\`\`\`\n\n---`,
        );
      }
    }
  }

  const ruleGroups = new Map();
  for (const r of rules) {
    const k = `${r.title}\0${r.link}`;
    if (!ruleGroups.has(k)) ruleGroups.set(k, []);
    ruleGroups.get(k).push(`- ${r.para}`);
  }
  const rulesBody = [...ruleGroups.entries()]
    .map(([k, items]) => `## ${k.split("\0")[0]}\n\n${k.split("\0")[1]}\n\n${items.join("\n")}`)
    .join("\n\n");

  return {
    userPromptsMd: `# 用户 prompt 逐字汇编\n\n> 机器汇编，零过滤零摘要，逐字保留。共 ${user.length} 条。\n\n${user.join("\n\n")}\n`,
    agentPromptsMd: `# 子代理派发提示词汇编\n\n> 提示词逐字保留；答复见各会话转写。共 ${agent.length} 次派发。\n\n${agent.join("\n\n")}\n`,
    rulesMd: `# 规则段抽取\n\n> 抽取规则：用户消息中含「禁用/不要/必须/一律/永远/记住/以后/红线/规则/口径…」等标记的自然段。\n> **这是正则命中，不是归纳**；是否成立、是否仍生效，由人判断。共 ${rules.length} 条。\n\n${rulesBody}\n`,
    counts: { user: user.length, agent: agent.length, rules: rules.length },
  };
}

// ── 脱敏层 ──────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  ["openai/anthropic", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["semantic-scholar", /\bs2k-[A-Za-z0-9_-]{12,}\b/g],
  ["github", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["aws", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["huggingface", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["pem", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
];

const KEYWORD_RE = /key|token|secret|password|passwd|bearer|credential|凭据|密钥/i;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const mixedClasses = (tok) => /[a-z]/.test(tok) && /[A-Z0-9]/.test(tok) && !/^[0-9a-f]+$/i.test(tok);

/**
 * 白名单替换 + 关键词行高熵替换；不含关键词的长混合 token 只进疑似清单。
 * @param {string} text
 * @returns {{text:string, redactions:{type:string,len:number}[], suspects:string[]}}
 */
export function redactText(text) {
  const redactions = [];
  let out = text;
  for (const [type, re] of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      redactions.push({ type, len: m.length });
      return `[已脱敏:${type} 长度${m.length}]`;
    });
  }
  const suspects = [];
  const outLines = out.split("\n").map((line) => {
    const toks = line.match(LONG_TOKEN_RE) ?? [];
    if (toks.length === 0) return line;
    if (KEYWORD_RE.test(line)) {
      let l = line;
      for (const tok of toks) {
        if (!mixedClasses(tok)) continue;
        redactions.push({ type: "keyword-line", len: tok.length });
        l = l.replace(tok, `[已脱敏:keyword-line 长度${tok.length}]`);
      }
      return l;
    }
    for (const tok of toks) {
      // slug/文件名/工具名样（多下划线、多连字符、日期开头）不进疑似清单——它们不是密钥形态
      const sluggy =
        (tok.match(/_/g) ?? []).length >= 2 || (tok.match(/-/g) ?? []).length >= 3 || /^\d{4}-\d{2}-\d{2}/.test(tok);
      if (tok.length >= 40 && mixedClasses(tok) && !sluggy && suspects.length < 20)
        suspects.push(`${tok.slice(0, 12)}…（长度${tok.length}）`);
    }
    return line;
  });
  return { text: outLines.join("\n"), redactions, suspects };
}
