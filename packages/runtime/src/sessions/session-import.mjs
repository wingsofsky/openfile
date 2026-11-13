#!/usr/bin/env node
/** 会话导入器：把任意 agent 的本地聊天转写落成文库里的可读 md 档案。用法、选项与分类规则见下面的 USAGE（--help 原样打印）。 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, canonicalRoot, resolveScoped, resolveWritePathCreating } from "../lib/scoped.mjs";
import {
  archiveUntouched,
  buildPromptBooks,
  detectFormat,
  isSubsetSession,
  parseSession,
  projectBucket,
  redactText,
  renderMarkdown,
  suggestFileName,
  withChecksum,
} from "../lib/session-convert.mjs";

const MAX_RAW = 256 * 1024 * 1024; // 单个转写上限，超过跳过并提示

function parseArgs(argv) {
  const a = { source: "auto", out: "会话/导入", project: process.cwd(), limit: Infinity, redact: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--root") a.root = argv[++i];
    else if (k === "--project") a.project = argv[++i];
    else if (k === "--source") a.source = argv[++i];
    else if (k === "--file") a.file = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--limit") a.limit = Number(argv[++i]);
    else if (k === "--list") a.list = true;
    else if (k === "--index") a.indexOnly = true;
    else if (k === "--reorganize") a.reorganize = true;
    else if (k === "--force") a.force = true;
    else if (k === "--sidechains") a.sidechains = true;
    else if (k === "--all-projects") a.allProjects = true;
    else if (k === "--prompts") a.prompts = true;
    else if (k === "--no-redact") a.redact = false;
    else if (k === "--help" || k === "-h") a.help = true;
    else {
      console.error(`未知参数: ${k}（--help 看用法）`);
      process.exit(2);
    }
  }
  return a;
}

/** Claude Code 的项目目录 slug：绝对路径逐字符映射，非 [A-Za-z0-9-] 一律 '-' */
const ccSlug = (abs) => abs.split("").map((c) => (/[a-zA-Z0-9-]/.test(c) ? c : "-")).join("");

function discover(source, project, allProjects = false) {
  const home = os.homedir();
  const found = [];
  const push = (file, src, meta = null) => {
    try {
      const st = fs.statSync(file);
      if (st.isFile()) found.push({ file, source: src, mtime: st.mtimeMs, size: st.size, meta });
    } catch {}
  };
  const readdirSafe = (d, opts) => {
    try {
      return fs.readdirSync(d, opts);
    } catch {
      return [];
    }
  };
  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };

  if (source === "auto" || source === "claude-code") {
    const base = path.join(home, ".claude", "projects");
    const dirs = allProjects ? readdirSafe(base) : [ccSlug(path.resolve(project))];
    for (const d of dirs) for (const f of readdirSafe(path.join(base, d))) {
      if (f.endsWith(".jsonl")) push(path.join(base, d, f), "claude-code", allProjects ? null : { cwd: path.resolve(project) });
    }
  }
  if (source === "auto" || source === "codex") {
    const walk = (d, depth) => {
      if (depth > 4) return;
      for (const e of readdirSafe(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith(".jsonl")) push(p, "codex");
      }
    };
    walk(path.join(home, ".codex", "sessions"), 0);
    walk(path.join(home, ".codex", "archived_sessions"), 0);
  }
  if (source === "auto" || source === "gemini") {
    const base = path.join(home, ".gemini", "tmp");
    for (const h of readdirSafe(base)) {
      const chats = path.join(base, h, "chats");
      for (const f of readdirSafe(chats)) if (f.endsWith(".json")) push(path.join(chats, f), "gemini");
    }
  }
  // Grok Build：每个 cwd 一个百分号编码目录，下面每个会话一个目录；chat_history.jsonl 是对话，summary.json 是元数据
  if (source === "auto" || source === "grok") {
    const base = path.join(home, ".grok", "sessions");
    for (const d of readdirSafe(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const cwdDir = path.join(base, d.name);
      for (const sd of readdirSafe(cwdDir, { withFileTypes: true })) {
        if (!sd.isDirectory()) continue;
        push(path.join(cwdDir, sd.name, "chat_history.jsonl"), "grok", grokMeta(path.join(cwdDir, sd.name, "summary.json"), sd.name, d.name));
      }
    }
  }
  // Antigravity CLI：brain/<会话 id>/.system_generated/logs/transcript_full.jsonl。
  // 工作目录与标题：conversation_summaries.db（每个会话一行，workspace_uris / title / preview）最全；
  // 读不了时退回 cache/last_conversations.json（只记每个 cwd 最近一个会话）。
  if (source === "auto" || source === "agy") {
    const base = path.join(home, ".gemini", "antigravity-cli");
    const metaOf = agyConversationMeta(base);
    const last = readJson(path.join(base, "cache", "last_conversations.json"));
    if (last && typeof last === "object") {
      for (const [cwd, id] of Object.entries(last)) {
        if (typeof id === "string" && !metaOf.get(id)?.cwd) metaOf.set(id, { ...(metaOf.get(id) ?? {}), cwd });
      }
    }
    for (const id of readdirSafe(path.join(base, "brain"))) {
      const logs = path.join(base, "brain", id, ".system_generated", "logs");
      const full = path.join(logs, "transcript_full.jsonl");
      push(fs.existsSync(full) ? full : path.join(logs, "transcript.jsonl"), "agy", { id, cwd: null, ...(metaOf.get(id) ?? {}) });
    }
  }
  // Cursor Agent CLI：projects/<slug>/agent-transcripts/<id>/<id>.jsonl；cwd 与起止毫秒在 chats/<hash>/<id>/meta.json
  if (source === "auto" || source === "cursor") {
    const base = path.join(home, ".cursor");
    const metaOf = new Map();
    for (const h of readdirSafe(path.join(base, "chats"))) {
      const hd = path.join(base, "chats", h);
      for (const id of readdirSafe(hd)) {
        const m = readJson(path.join(hd, id, "meta.json"));
        if (!m) continue;
        metaOf.set(id, {
          id,
          cwd: typeof m.cwd === "string" ? m.cwd : null,
          startedAt: typeof m.createdAtMs === "number" ? new Date(m.createdAtMs).toISOString() : null,
          endedAt: typeof m.updatedAtMs === "number" ? new Date(m.updatedAtMs).toISOString() : null,
        });
      }
    }
    for (const p of readdirSafe(path.join(base, "projects"))) {
      const td = path.join(base, "projects", p, "agent-transcripts");
      for (const id of readdirSafe(td)) push(path.join(td, id, `${id}.jsonl`), "cursor", metaOf.get(id) ?? { id });
    }
  }
  return found.sort((x, y) => y.mtime - x.mtime);
}

/** grok 会话旁的 summary.json → meta（没有文件时只有 id 与从目录名解出的 cwd） */
function grokMeta(summaryFile, id, encodedCwd) {
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
  } catch {}
  let cwd = j?.info?.cwd ?? null;
  if (!cwd && encodedCwd) {
    try {
      cwd = decodeURIComponent(encodedCwd);
    } catch {}
  }
  const model = j?.current_model_id ? `${j.current_model_id}${j.reasoning_effort ? ` · 思考 ${j.reasoning_effort}` : ""}` : null;
  return {
    id: j?.info?.id ?? id ?? null,
    cwd,
    startedAt: j?.created_at ?? null,
    endedAt: j?.updated_at ?? j?.last_active_at ?? null,
    title: j?.generated_title || j?.session_summary || null,
    model,
  };
}

/** file:///d%3A/x → D:\x；file:///Users/a/x → /Users/a/x */
function fileUriToPath(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return null;
  let p;
  try {
    p = decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
  const drive = /^\/?([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (drive) return path.win32.normalize(`${drive[1].toUpperCase()}:\\${drive[2]}`);
  return p || null;
}

/** agy 的会话摘要库（sqlite，只读）→ Map(id → {cwd, title, endedAt})；Node 不带 node:sqlite 或库读不了就返回空表 */
function agyConversationMeta(base) {
  const out = new Map();
  const file = path.join(base, "conversation_summaries.db");
  if (!fs.existsSync(file)) return out;
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes("SQLite") ? undefined : emit.call(process, w, ...rest));
  let db;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true });
    for (const r of db.prepare("SELECT conversation_id, title, preview, workspace_uris, last_modified_time FROM conversation_summaries").all()) {
      let uris = [];
      try {
        uris = JSON.parse(String(r.workspace_uris || "[]"));
      } catch {}
      out.set(String(r.conversation_id), {
        id: String(r.conversation_id),
        cwd: Array.isArray(uris) && uris.length > 0 ? fileUriToPath(String(uris[0])) : null,
        title: String(r.title || r.preview || "").trim() || null,
        endedAt: r.last_modified_time ? String(r.last_modified_time) : null,
      });
    }
  } catch {
    // 没有 node:sqlite（Node < 22.13）或库被占用 / 结构变了：退回 last_conversations.json
  } finally {
    try {
      db?.close();
    } catch {}
    process.emitWarning = emit;
  }
  return out;
}

const FORMAT_OF_SOURCE = { "claude-code": "claude-code", codex: "codex", gemini: "gemini-history", grok: "grok", agy: "antigravity", cursor: "cursor" };

function convertOne(entry, opts) {
  const raw = fs.readFileSync(entry.file, "utf8");
  const format = FORMAT_OF_SOURCE[entry.source] ?? detectFormat(raw);
  if (!format) return null;
  let meta = entry.meta ?? null;
  // --file 直接导 grok 的 chat_history.jsonl：旁边的 summary.json 顺手读进来
  if (!meta && format === "grok") meta = grokMeta(path.join(path.dirname(entry.file), "summary.json"), null, null);
  const s = parseSession(raw, format, { ...opts, meta: meta ?? undefined });
  if (!s.id) s.id = path.basename(entry.file).replace(/\.[^.]+$/, "");
  // cursor 的子 agent 转写没有 meta.json，父 agent 派活时把工作目录写在第一行
  if (!s.cwd && s.source === "cursor") {
    const first = s.turns.find((t) => t.role === "user")?.text ?? "";
    const m = /^Working directory: (\S.*?)\s*$/m.exec(first.split("\n")[0]);
    if (m && (path.win32.isAbsolute(m[1]) || m[1].startsWith("/"))) s.cwd = m[1];
  }
  return s;
}

/** 原始转写路径的对账键（Windows 路径不分大小写、斜杠方向） */
const originKey = (p) => (/^[A-Za-z]:[\\/]|^\\\\/.test(p) ? path.win32.normalize(p).toLowerCase() : path.posix.normalize(p));

const gitRootCache = new Map();
/** 从 dir 往上找含 .git 的目录（只看本机现存路径；拿不到返回 null） */
function gitRootOf(dir) {
  if (gitRootCache.has(dir)) return gitRootCache.get(dir);
  if (/^\\\\|^\/\//.test(dir)) return null; // UNC / 网络路径不探测：网络盘掉线时每次 stat 都可能卡很久
  let found = null;
  let cur = dir;
  for (let i = 0; i < 32; i++) {
    try {
      if (fs.existsSync(path.join(cur, ".git"))) {
        found = cur;
        break;
      }
    } catch {}
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  gitRootCache.set(dir, found);
  return found;
}

const BUCKET_CTX = { home: os.homedir(), tmpDir: os.tmpdir(), gitRoot: gitRootOf };
/** 会话 → 归档分组（按 cwd） */
const bucketOf = (s) => projectBucket(s.cwd, BUCKET_CTX);

/** 档案头里对账要用的字段（新渲染的与盘上已有的用同一套解析，比较才公平） */
function parseArchiveHead(text) {
  const src = /^- 来源: (\S+)(?: · id `([^`]+)`)?/m.exec(text);
  const turns = /轮次: (\d+) 用户 \/ (\d+) 助手/.exec(text);
  const time = /^- 时间: (.+?) → (.+?) · /m.exec(text);
  const imp = /^- 导入: (\d{4}-\d\d-\d\d \d\d:\d\d)(?: · 原始转写: `([^`]+)`)?/m.exec(text);
  const proj = /^- 项目: (.+?)(?:（分支 .*）)?$/m.exec(text);
  return {
    source: src?.[1] ?? null,
    id: src?.[2] ?? null,
    turns: turns ? Number(turns[1]) + Number(turns[2]) : null,
    ended: time?.[2]?.trim() ?? null,
    importedAt: imp?.[1] ?? null,
    origin: imp?.[2] ?? null,
    project: proj?.[1]?.trim() ?? null,
  };
}

/** 落库目录里的档案：根层 + 一层分组目录（_prompts 不算；符号链接不跟） */
function scanArchives(root, outRel) {
  const out = [];
  const visit = (relDir, depth) => {
    let ents = [];
    try {
      ents = fs.readdirSync(resolveScoped(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (depth === 0 && e.name !== "_prompts") visit(rel, 1);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".md") || e.name === "索引.md") continue;
      try {
        const abs = resolveScoped(root, rel);
        const fd = fs.openSync(abs, "r");
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        out.push({ rel, name: e.name, dir: relDir, mtimeMs: fs.statSync(abs).mtimeMs, ...parseArchiveHead(buf.toString("utf8", 0, n)) });
      } catch {}
    }
  };
  visit(outRel, 0);
  return out;
}

/** 档案自导入后是否没被改过：有校验行看校验；没有的看修改时间是否不晚于导入时刻 + 10 分钟 */
function archiveIsPristine(root, arch) {
  let text;
  try {
    text = fs.readFileSync(resolveScoped(root, arch.rel), "utf8");
  } catch {
    return false;
  }
  const verdict = archiveUntouched(text);
  if (verdict !== null) return verdict;
  if (!arch.importedAt) return false;
  const [d, t] = arch.importedAt.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const imported = new Date(y, mo - 1, da, h, mi).getTime();
  return arch.mtimeMs <= imported + 10 * 60 * 1000;
}

/** 档案正文（头部分隔线之后） */
const bodyOf = (md) => {
  const t = md.replace(/\r\n/g, "\n");
  const i = t.indexOf("\n---\n");
  return i === -1 ? t : t.slice(i + 5);
};
/**
 * 新渲染能否替换旧档案：旧正文除最后一轮外须逐字是新正文的前缀（最后一轮可能还在长），且新正文不更短。
 * 原始记录被上游改写 / 压缩 / 截断，或脱敏规则变了，都会对不上——那就保留旧档案，宁可不刷新也不丢字。
 */
function coversArchive(oldMd, newMd) {
  const a = bodyOf(oldMd);
  const b = bodyOf(newMd);
  if (a === b) return true;
  const lastTurn = a.lastIndexOf("\n## ");
  const stable = lastTurn > 0 ? a.slice(0, lastTurn) : "";
  if (!b.startsWith(stable) || b.length < a.length) return false;
  // 最后一轮的正文开头也得还在。跳过标题行（时间可能变）与「〔工具〕」清点行（轮次长了清点数会变，
  // 续写的文字也插在它前面）
  const lastBody = a
    .slice(lastTurn + 1)
    .split("\n")
    .slice(1)
    .filter((l) => !l.startsWith("> 〔工具〕"))
    .join("\n")
    .trim()
    .slice(0, 400);
  return lastBody === "" || b.slice(stable.length).includes(lastBody);
}

/** 同一目录下不撞名：撞了在 .md 前加原始路径的短哈希 */
function freeName(root, dirRel, name, origin, taken) {
  const busy = (n) => taken.has(`${dirRel}/${n}`) || (() => {
    try {
      resolveScoped(root, `${dirRel}/${n}`);
      return true;
    } catch {
      return false;
    }
  })();
  if (!busy(name)) return name;
  let h = 0;
  for (const c of String(origin ?? name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const tag = h.toString(16).padStart(8, "0").slice(0, 6);
  for (let i = 0; i < 100; i++) {
    const n = name.replace(/\.md$/, `-${tag}${i ? `-${i}` : ""}.md`);
    if (!busy(n)) return n;
  }
  throw new Error(`档案名冲突无法化解: ${dirRel}/${name}`);
}

const localStamp = () => {
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
};

/** 档案正文里第一条用户消息（索引「首句」用） */
function firstUserLines(text, n = 3) {
  const out = [];
  let i = text.indexOf("\n## 用户");
  while (i !== -1 && out.length < n) {
    const after = text.slice(i).split("\n").slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (after[0]) out.push(after[0]);
    i = text.indexOf("\n## 用户", i + 1);
  }
  return out;
}

/**
 * 跨 agent 会话索引：扫描落库目录（含各项目子目录）里每份档案的头部（标题 / 来源 / 时间 / 轮次 / 首条用户消息），
 * 生成 <out>/索引.md（项目一览 + 全部档案按时间新的在前）与每个项目目录里的 索引.md。
 * agent 回忆时先扫这一页，再 search_text / read_doc。
 * 表格列序：前 7 列不动，「项目」只能追加在最后——已生成的索引都按这个列序读。
 */
export function buildSessionIndex(root, outRel) {
  try {
    resolveScoped(root, outRel);
  } catch {
    return null;
  }
  const rows = [];
  for (const arch of scanArchives(root, outRel)) {
    let full = "";
    try {
      full = fs.readFileSync(resolveScoped(root, arch.rel), "utf8").slice(0, 8 * 1024 * 1024);
    } catch {
      continue;
    }
    const text = full.slice(0, 8000); // 头部字段只在开头
    // 子代理派发的模型构成：整份扫 〔派发〕类型/模型 行
    const mix = new Map();
    for (const m of full.matchAll(/^> 〔派发〕([^/\n]+)\/([^\s·\n]+)/gm)) {
      const model = m[2].trim();
      if (model) mix.set(model, (mix.get(model) ?? 0) + 1);
    }
    const bucket = arch.dir === outRel ? "" : arch.dir.slice(outRel.length + 1);
    rows.push({
      name: arch.name,
      bucket,
      time: (/^- 时间: ([^·\n]+)/m.exec(text)?.[1] ?? "").trim().split(" → ")[0] || arch.name.slice(0, 13),
      source: (/^- 来源: ([^·\n]+)/m.exec(text)?.[1] ?? "?").trim(),
      title: (/^# 会话：(.*)$/m.exec(text)?.[1] ?? arch.name).trim().replace(/\|/g, "｜").slice(0, 60),
      turns: (/轮次: ([^·\n]+)/m.exec(text)?.[1] ?? "").trim(),
      used: (/^- 主控用量: (\d+) tokens/m.exec(text)?.[1] ?? "") || "—",
      mix: [...mix.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" · ") || "—",
      first: (firstUserLines(text, 1)[0] ?? "").replace(/\|/g, "｜").slice(0, 80),
    });
  }
  // 新的在前：档案名以「年月日-时分」开头，同一时刻按项目、文件名稳定排序
  rows.sort((x, y) => y.name.slice(0, 13).localeCompare(x.name.slice(0, 13)) || x.bucket.localeCompare(y.bucket) || y.name.localeCompare(x.name));
  const row = (r, href, withBucket) =>
    `| ${r.time} | ${r.source} | [${r.title}](${href}) | ${r.turns} | ${r.used} | ${r.mix} | ${r.first} |${withBucket ? ` ${r.bucket || "—"} |` : ""}`;

  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.bucket)) groups.set(r.bucket, []);
    groups.get(r.bucket).push(r);
  }
  const named = [...groups.entries()].filter(([b]) => b !== "");
  // 项目一览：真实项目按份数多的在前，下划线开头的特殊分组排最后
  named.sort((x, y) => Number(x[0].startsWith("_")) - Number(y[0].startsWith("_")) || y[1].length - x[1].length || x[0].localeCompare(y[0]));
  const sourcesOf = (list) => {
    const m = new Map();
    for (const r of list) m.set(r.source, (m.get(r.source) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
  };
  const md = [
    "# 会话索引",
    "",
    `跨 agent 的对话档案一览（${rows.length} 份，${named.length} 个项目分组；由 session-import 重建，勿手改）。回忆「哪天说过什么」：先扫这页或项目目录里的 索引.md，再 search_text 关键词，命中后 read_doc 详读。「主控用量」是主控自己新处理的 token（输入+输出+缓存创建，不含每轮重复计的缓存读），「子代理派发」是派给子代理的模型构成。`,
    "",
    "## 按项目",
    "",
    "| 项目 | 份数 | 最近 | 来源 |",
    "|---|---|---|---|",
    ...named.map(([b, list]) => `| [${b}](${b}/索引.md) | ${list.length} | ${list[0].time} | ${sourcesOf(list)} |`),
    ...(groups.has("") ? [`| （未归类，跑 --reorganize 整理） | ${groups.get("").length} | ${groups.get("")[0].time} | ${sourcesOf(groups.get(""))} |`] : []),
    "",
    "特殊分组：`_临时` = 临时目录里开的会话；`_杂项` = 不在项目里（盘符根、主目录、应用数据目录）；`_未知项目` = 原始记录没有工作目录。",
    "",
    "## 全部（新的在前）",
    "",
    "| 时间 | 来源 | 标题 | 轮次 | 主控用量 | 子代理派发 | 首句 | 项目 |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => row(r, r.bucket ? `${r.bucket}/${r.name}` : r.name, true)),
    "",
  ].join("\n");
  atomicWriteFile(resolveWritePathCreating(root, `${outRel}/索引.md`), md);
  for (const [b, list] of named) {
    const sub = [
      `# 会话索引 · ${b}`,
      "",
      `${list.length} 份，新的在前；由 session-import 重建，勿手改。[← 全部项目](../索引.md)`,
      "",
      "| 时间 | 来源 | 标题 | 轮次 | 主控用量 | 子代理派发 | 首句 |",
      "|---|---|---|---|---|---|---|",
      ...list.map((r) => row(r, r.name, false)),
      "",
    ].join("\n");
    atomicWriteFile(resolveWritePathCreating(root, `${outRel}/${b}/索引.md`), sub);
  }
  return { path: `${outRel}/索引.md`, count: rows.length, groups: named.length };
}

/**
 * 整理已有档案：按项目归入子目录；原始转写还在、档案没被手改过的，按当前解析器重渲染（标题、项目、轮次、校验随之更新）；
 * 被手改过或原始转写已删的只搬家不动内容。先写新位置再删旧位置，任何一步失败都不丢档案。
 */
function reorganize(root, a) {
  const archives = scanArchives(root, a.out);
  const byOrigin = new Map();
  for (const e of discover("auto", a.project, true)) byOrigin.set(originKey(e.file), e);
  const stamp = localStamp();
  const plans = [];
  for (const arch of archives) {
    const entry = arch.origin ? byOrigin.get(originKey(arch.origin)) : undefined;
    let session = null;
    if (entry && entry.size <= MAX_RAW && archiveIsPristine(root, arch)) {
      try {
        const s = convertOne(entry, { sidechains: a.sidechains });
        if (s && s.turns.length > 0) session = s;
      } catch {}
    }
    let bucket;
    if (session) bucket = bucketOf(session);
    else {
      let text = "";
      try {
        text = fs.readFileSync(resolveScoped(root, arch.rel), "utf8").slice(0, 64 * 1024);
      } catch {}
      bucket = projectBucket(arch.project, BUCKET_CTX);
    }
    plans.push({ arch, entry, session, bucket, file: session ? suggestFileName(session) : arch.name });
  }
  // fork 标注只在可重渲染的会话之间重算
  const live = plans.filter((p) => p.session);
  for (const x of live) for (const y of live) if (x !== y && isSubsetSession(x.session, y.session)) (x.forkOf ??= []).push(y.file);

  const taken = new Set();
  let moved = 0;
  let rerendered = 0;
  let kept = 0;
  const diverged = [];
  const redactionTally = new Map();
  for (const p of plans) {
    // 先渲染再定名：原始记录对不上旧档案时只搬家、不改名不改内容
    let md = null;
    if (p.session) {
      const rendered = renderMarkdown(p.session, {
        importedAt: p.arch.importedAt ?? stamp, // 「导入」记首次入库时刻
        originPath: p.entry.file,
        extraHeader: p.forkOf ? [`⚠ 疑似 fork/子集 → ${p.forkOf.join("、")}（两份都留，取舍由人）`] : [],
      });
      const red = a.redact ? redactText(rendered) : { text: rendered, redactions: [] };
      let old = "";
      try {
        old = fs.readFileSync(resolveScoped(root, p.arch.rel), "utf8");
      } catch {}
      if (coversArchive(old, red.text)) {
        md = red.text;
        for (const { type } of red.redactions) redactionTally.set(type, (redactionTally.get(type) ?? 0) + 1);
      } else {
        diverged.push(p.arch.rel);
        p.file = p.arch.name;
      }
    }
    const dirRel = `${a.out}/${p.bucket}`;
    const sameDir = p.arch.dir === dirRel;
    let name = p.file;
    if (!(sameDir && name === p.arch.name)) name = freeName(root, dirRel, name, p.arch.origin, taken);
    const rel = `${dirRel}/${name}`;
    taken.add(rel);
    if (md !== null) {
      atomicWriteFile(resolveWritePathCreating(root, rel), withChecksum(md));
      rerendered++;
      if (rel !== p.arch.rel) {
        fs.unlinkSync(resolveScoped(root, p.arch.rel)); // 单文件删除用 unlinkSync（Node 24 Windows 上 rmSync 删单文件会崩）
        moved++;
      }
    } else if (rel !== p.arch.rel) {
      const src = resolveScoped(root, p.arch.rel);
      const dst = resolveWritePathCreating(root, rel);
      fs.renameSync(src, dst);
      moved++;
    } else kept++;
  }
  // 搬空的旧分组目录（只删空目录）
  for (const e of fs.readdirSync(resolveScoped(root, a.out), { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === "_prompts") continue;
    try {
      const dirAbs = resolveScoped(root, `${a.out}/${e.name}`);
      const left = fs.readdirSync(dirAbs).filter((n) => n !== "索引.md");
      if (left.length === 0) {
        try {
          fs.unlinkSync(path.join(dirAbs, "索引.md"));
        } catch {}
        fs.rmdirSync(dirAbs);
      }
    } catch {}
  }
  const r = buildSessionIndex(root, a.out);
  console.log(`整理完成：${archives.length} 份档案，重渲染 ${rerendered}，换位置/改名 ${moved}，原样保留 ${kept}。`);
  if (redactionTally.size > 0) console.log(`重渲染中脱敏 ${[...redactionTally.values()].reduce((x, y) => x + y, 0)} 处。`);
  if (diverged.length > 0) {
    console.log(`⚠ ${diverged.length} 份原始记录与档案前文对不上（上游改写/压缩了记录，或脱敏规则变了），只搬家、保留旧内容：`);
    for (const d of diverged) console.log(`  - ${d}`);
  }
  if (r) console.log(`已重建 ${r.path}（${r.count} 份，${r.groups} 个项目分组）`);
}

const USAGE = `会话导入器 —— 把任意 agent 的本地聊天转写"扣"进文库，落成可读 md 档案。

  openfile import-sessions --root <文库> [--project <目录>] [--source auto]

选项：
  --root <dir>      文库根（必填；写入经 scoped 路径出证 + 原子写）
  --project <dir>   只导入属于这个项目的会话（默认当前目录；项目未知的跳过）
  --all-projects    明确导入本机所有项目（含项目未知的记录）；注意项目隐私边界
  --source <s>      auto | claude-code | codex | gemini | grok | agy | cursor | file（默认 auto：发现什么导什么）
                    各家的本地存储：claude-code ~/.claude/projects/<项目 slug>/*.jsonl（按 --project）；
                    codex ~/.codex/sessions/** 与 archived_sessions；gemini ~/.gemini/tmp/<hash>/chats；
                    grok ~/.grok/sessions/<cwd 编码>/<id>/chat_history.jsonl（+ summary.json）；
                    agy ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl；
                    cursor ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl（+ ~/.cursor/chats/<hash>/<id>/meta.json）
  --file <path>     直接导入单个转写文件（配 --source 指明格式，不指则自动嗅探）
  --out <rel>       落库目录（默认 会话/导入）
  --list            只列出可导入的会话，不写盘
  --index           只重建索引（会话/导入/索引.md + 各项目目录的 索引.md），不导入
  --reorganize      整理已有档案：按项目归入子目录、按当前解析器重渲染未被手改的档案（标题/项目/轮次随之更新）
  --limit <N>       最多导入 N 个新档案（从最新扫起）
  --force           已导入过也重写（含被手改过的档案）
  --sidechains      连子代理转写一起导（默认跳过）
  --prompts         另产三册提炼：_prompts/USER_PROMPTS.md（用户逐字）、AGENT_PROMPTS.md
                    （派发提示词）、USER_RULES.md（规则段正则抽取——命中非归纳，人来判断）
  --no-redact       关闭脱敏（默认开：白名单模式 + 关键词行高熵替换 + 疑似清单）

分类：档案落在 <out>/<项目>/ 下（projectBucket：git 根目录名或项目层目录名；worktree 归回主仓库；
      临时目录 → _临时，盘符根/主目录/应用数据 → _杂项，没有项目来源 → _未知项目）。
幂等：对账键是原始转写路径（同一会话 id 的分叉线程各算一份），档案头里没有原始路径时退回会话 id。
续写：会话在导入后又继续了（轮次或结束时间变了），档案原地刷新；档案头的「校验」行证明它自导入后没被人改过，
      改过的不覆盖、列出来（--force 才覆盖）。没有校验行的档案以「修改时间不晚于导入后 10 分钟」为未改动。
fork 检测：用户消息 hash 集合 A ⊊ B 时给 A 的档案头加标注，两份都留、不删。
脱敏清单必须人过目后才推远端；白名单永远会漏，漏网密钥第一时间吊销重发。`;

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.root) {
    console.log(USAGE);
    process.exit(a.help ? 0 : 2);
  }
  let root;
  try {
    root = canonicalRoot(path.resolve(a.root));
  } catch {
    console.error(`文库根不可访问: ${a.root}`);
    process.exit(2);
  }

  let indexDirty = false;
  if (a.indexOnly) {
    const r = buildSessionIndex(root, a.out);
    console.log(r ? `已重建 ${r.path}（${r.count} 份，${r.groups} 个项目分组）` : `没有 ${a.out}/ 目录`);
    return;
  }
  if (a.reorganize) {
    reorganize(root, a);
    return;
  }

  const entries = a.file
    ? [{ file: path.resolve(a.file), source: a.source === "auto" || a.source === "file" ? "file" : a.source, mtime: 0, size: fs.statSync(path.resolve(a.file)).size }]
    : discover(a.source, a.project, a.allProjects);

  if (entries.length === 0) {
    console.log("没有发现可导入的会话（检查 --project 是否是 agent 干活的目录）。");
    return;
  }

  // 阶段一：全量解析（fork 检测需要所有会话的用户消息 hash 集合）
  const converted = [];
  let skipped = 0;
  let skippedProject = 0;
  const normalizeProject = (value) => /^[A-Za-z]:[\\/]/.test(value)
    ? path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase()
    : path.resolve(value);
  for (const e of entries) {
    if (e.size > MAX_RAW) {
      console.log(`跳过（超 ${MAX_RAW / 1024 / 1024}MB）: ${e.file}`);
      skipped++;
      continue;
    }
    try {
      const s = convertOne(e, { sidechains: a.sidechains });
      // Native discovery can span an account. Unknown cwd never means consent to mix projects.
      // An explicit --file or --all-projects is the user's deliberate source selection.
      if (s && !a.file && !a.allProjects && (!s.cwd || normalizeProject(s.cwd) !== normalizeProject(a.project))) {
        skippedProject++;
        skipped++;
        continue;
      }
      if (s && s.turns.length > 0) converted.push({ entry: e, session: s, file: suggestFileName(s) });
      else skipped++;
    } catch (err) {
      console.error(`解析失败: ${e.file} —— ${err instanceof Error ? err.message : err}`);
      skipped++;
    }
  }

  // fork 标注：A ⊊ B ⇒ A 头部标"疑似 fork/子集"，两份都留
  for (const x of converted) {
    for (const y of converted) {
      if (x !== y && isSubsetSession(x.session, y.session)) {
        (x.forkOf ??= []).push(y.file);
      }
    }
  }

  // 对账：已有档案按原始转写路径认领（同一会话 id 的分叉线程是不同的转写文件，各算一份）；
  // 档案头里没有原始路径时退回会话 id。只比文件名里的 id 前 8 位会把时间有序的 UUIDv7 误判成已导入。
  const archives = scanArchives(root, a.out);
  const archByOrigin = new Map();
  const archById = new Map();
  for (const arch of archives) {
    if (arch.origin) archByOrigin.set(originKey(arch.origin), arch);
    if (arch.id) {
      if (!archById.has(arch.id)) archById.set(arch.id, []);
      archById.get(arch.id).push(arch);
    }
  }
  const baseOf = (p) => p.replace(/\\/g, "/").split("/").pop().toLowerCase();
  /** 认领顺序：原始路径相同 → 同 id 且（档案没记路径 / 转写文件同名换了目录，如 codex 归档 / 原路径已不在） */
  const findArchive = (x) => {
    const hit = archByOrigin.get(originKey(x.entry.file));
    if (hit) return hit;
    const base = baseOf(x.entry.file);
    return (x.session.id ? archById.get(x.session.id) ?? [] : []).find(
      (c) => !c.origin || baseOf(c.origin) === base || !fs.existsSync(c.origin),
    );
  };

  // 阶段二：渲染 + 脱敏 + 写盘（新会话按项目落子目录；长大了的会话原地刷新）
  const stamp = localStamp();
  const redactionTally = new Map();
  const allSuspects = [];
  const taken = new Set();
  const touched = [];
  const diverged = [];
  const versioned = [];
  let done = 0;
  let refreshed = 0;
  for (const x of converted) {
    if (done >= a.limit) break;
    const arch = findArchive(x);
    if (a.list) {
      const fork = x.forkOf ? `  ⚠ 疑似 fork → ${x.forkOf[0]}` : "";
      const state = arch ? `  [已归档 ${arch.rel.slice(a.out.length + 1)}]` : `  [新 → ${bucketOf(x.session)}]`;
      console.log(`${x.file}  ← ${x.entry.source}  ${x.session.turns.length} 轮  ${x.entry.file}${fork}${state}`);
      done++;
      continue;
    }
    let md = renderMarkdown(x.session, {
      importedAt: arch?.importedAt ?? stamp, // 「导入」记首次入库时刻，刷新不改
      originPath: x.entry.file,
      extraHeader: x.forkOf ? [`⚠ 疑似 fork/子集 → ${x.forkOf.join("、")}（两份都留，取舍由人）`] : [],
    });
    const fresh = parseArchiveHead(md);
    const red = a.redact ? redactText(md) : { text: md, redactions: [], suspects: [] };
    md = red.text;
    let rel;
    if (arch) {
      const grown =
        (fresh.turns ?? 0) > (arch.turns ?? 0) ||
        (fresh.turns === arch.turns && fresh.ended && arch.ended && fresh.ended !== "?" && fresh.ended > arch.ended);
      if (!a.force && !grown) {
        skipped++;
        continue;
      }
      if (!a.force && !archiveIsPristine(root, arch)) {
        touched.push(`${arch.rel}（档案 ${arch.turns ?? "?"} 轮，原始记录已 ${fresh.turns} 轮）`);
        skipped++;
        continue;
      }
      if (!a.force) {
        let old = "";
        try {
          old = fs.readFileSync(resolveScoped(root, arch.rel), "utf8");
        } catch {}
        if (!coversArchive(old, md)) {
          // 前文对不上（多半是上游改写/压缩了记录）：原始记录轮次更多就以它为准，旧档案挪到同目录 _旧版/ 留底；
          // 只是结束时间变了的不动
          if ((fresh.turns ?? 0) <= (arch.turns ?? 0)) {
            diverged.push(`${arch.rel}（档案 ${arch.turns ?? "?"} 轮，原始记录 ${fresh.turns} 轮，前文对不上）`);
            skipped++;
            continue;
          }
          const keepDir = `${arch.dir}/_旧版`;
          const keep = `${keepDir}/${freeName(root, keepDir, arch.name, arch.origin, taken)}`;
          fs.renameSync(resolveScoped(root, arch.rel), resolveWritePathCreating(root, keep));
          taken.add(keep);
          versioned.push(`${arch.rel}（${arch.turns ?? "?"} → ${fresh.turns} 轮；旧档 → ${keep.slice(a.out.length + 1)}）`);
        }
      }
      rel = arch.rel; // 原地刷新，不挪位置（挪位置是 --reorganize 的事）
    } else {
      const dirRel = `${a.out}/${bucketOf(x.session)}`;
      rel = `${dirRel}/${freeName(root, dirRel, x.file, x.entry.file, taken)}`;
    }
    for (const { type } of red.redactions) redactionTally.set(type, (redactionTally.get(type) ?? 0) + 1);
    for (const s of red.suspects) allSuspects.push(`${rel.slice(a.out.length + 1)}: ${s}`);
    const target = resolveWritePathCreating(root, rel); // 路径安全不变量：写入必须出证
    atomicWriteFile(target, withChecksum(md));
    taken.add(rel);
    if (arch) {
      refreshed++;
      console.log(`已刷新: ${rel}（${arch.turns ?? "?"} → ${fresh.turns} 轮）`);
    } else console.log(`已入库: ${rel}（${x.session.turns.length} 轮）`);
    indexDirty = true;
    done++;
  }

  // 三册提炼（对已解析的全部会话做，不只本次新导入的——册子是全量视图）
  if (a.prompts && !a.list && converted.length > 0) {
    const books = buildPromptBooks(converted.map((x) => ({ session: x.session, file: x.file })));
    const write = (name, content) => {
      const body = a.redact ? redactText(content) : { text: content, redactions: [], suspects: [] };
      for (const { type } of body.redactions) redactionTally.set(type, (redactionTally.get(type) ?? 0) + 1);
      for (const s of body.suspects) allSuspects.push(`_prompts/${name}: ${s}`);
      const target = resolveWritePathCreating(root, `${a.out}/_prompts/${name}`);
      atomicWriteFile(target, body.text);
      console.log(`已产出: ${a.out}/_prompts/${name}`);
    };
    write("USER_PROMPTS.md", books.userPromptsMd);
    write("AGENT_PROMPTS.md", books.agentPromptsMd);
    write("USER_RULES.md", books.rulesMd);
    console.log(`提炼：用户 prompt ${books.counts.user} 条 · 派发 ${books.counts.agent} 次 · 规则段 ${books.counts.rules} 条`);
  }

  if (indexDirty && !a.list) {
    const r = buildSessionIndex(root, a.out);
    if (r) console.log(`已重建 ${r.path}（${r.count} 份，${r.groups} 个项目分组）`);
  }
  console.log(`完成：${a.list ? `列出 ${done}` : `导入 ${done - refreshed}，刷新 ${refreshed}`}，跳过 ${skipped}。`);
  if (touched.length > 0) {
    console.log(`⚠ ${touched.length} 份档案导入后被改过，会话又有新内容但没有覆盖（要覆盖用 --force；或先把改动挪走）：`);
    for (const t of touched.slice(0, 20)) console.log(`  - ${t}`);
  }
  if (versioned.length > 0) {
    console.log(`${versioned.length} 份会话的原始记录被上游改写过、但内容更多：已按原始记录刷新，旧档案留在 _旧版/：`);
    for (const t of versioned.slice(0, 20)) console.log(`  - ${t}`);
  }
  if (diverged.length > 0) {
    console.log(`⚠ ${diverged.length} 份会话的原始记录与档案前文对不上且不比档案多（上游改写/压缩了记录，或脱敏规则变了），保留旧档案未刷新（--force 强制按原始记录重写）：`);
    for (const t of diverged.slice(0, 20)) console.log(`  - ${t}`);
  }
  if (skippedProject) console.log(`其中 ${skippedProject} 份属于其他项目或缺少项目来源。要导入某一份，用 --file 显式指定；--all-projects 会包含所有项目。`);
  if (a.redact && !a.list) {
    if (redactionTally.size > 0) {
      const parts = [...redactionTally.entries()].map(([t, n]) => `${t}×${n}`);
      console.log(`已脱敏 ${[...redactionTally.values()].reduce((x, y) => x + y, 0)} 处（${parts.join(" · ")}）。`);
    } else console.log("脱敏：白名单与关键词行均零命中。");
    if (allSuspects.length > 0) {
      console.log(`⚠ 疑似高熵 token ${allSuspects.length} 条（未替换，请人工过目后再推远端）：`);
      for (const s of allSuspects.slice(0, 20)) console.log(`  - ${s}`);
    }
  }
}

main();
