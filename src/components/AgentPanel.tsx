/**
 * agent 会话面板：内嵌 ACP 会话的人侧表面（右停靠栏）。
 *
 * 不切终端完成整圈回环：签发任务 → 这里唤醒 agent →（工具/权限/计划
 * 逐条可见）→ 建议标记写回目标文档 → 阅读视图逐条接受。
 * 会话生命周期在 agent-controller（模块单例）；本组件纯渲染 + 派发。
 * 输入区守输入法规矩：原生 textarea、组合态回车不误发（isComposing 守卫）。
 */
import {
  ArrowUp,
  CircleNotch,
  Play,
  Stop,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolItem, TranscriptItem } from "../lib/acp";
import { absToRel } from "../lib/acp";
import { contextPercent, fmtTokens } from "../lib/token-format";
import {
  authenticate,
  cancelTurn,
  flushSessionArchive,
  resolvePermission,
  sendPrompt,
  setSessionMode,
  startSession,
  startSessionFromHistory,
  stopSession,
  undoTurn,
} from "../lib/agent-controller";
import { AGENT_PRESETS, useAgent } from "../state/agent";
import { useApp } from "../state/store";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { t } from "../i18n";
import { MOD } from "../lib/util";
import { backend } from "../lib/backend";
import { searchSessionHistory, type SessionHistoryItem } from "../lib/session-history";
import type { ConversationExportResult } from "../lib/types";
import { canOpenWindows, openLibraryWindow } from "../lib/windows";
import { PanelResizer } from "./PanelResizer";
import { groupTranscript, referencePath, summarizeActivity, type ActivityItem } from "../lib/transcript-view";

/** 渲染时取（模块加载时调 t() 会把文案定死在首次的语言） */
function statusLabel(status: string): string {
  switch (status) {
    case "idle": return t("未启动");
    case "starting": return t("握手中…");
    case "auth": return t("等待登录");
    case "ready": return t("就绪");
    case "running": return t("进行中…");
    case "exited": return t("已退出");
    case "error": return t("出错了");
    default: return status;
  }
}

/** 渲染时过 t()，键写成字面量（i18n 抽取只认字面量） */
function toolStatusLabel(status: string): string {
  switch (status) {
    case "pending": return t("待确认");
    case "in_progress": return t("执行中");
    case "completed": return t("完成");
    case "failed": return t("失败");
    default: return status;
  }
}

function LocationChips({ locations }: { locations: Array<{ path: string; line?: number | null }> }) {
  const root = useApp((s) => s.lib?.root);
  const openFile = useApp((s) => s.openFile);
  if (!root || locations.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {locations.slice(0, 4).map((loc, i) => {
        const rel = absToRel(root, loc.path);
        if (!rel) return null;
        return (
          <button
            key={i}
            className="max-w-full truncate font-mono text-[12px] text-accent-cool hover:underline"
            title={t("打开 {0}", [rel])}
            onClick={() => openFile(rel)}
          >
            {rel}
          </button>
        );
      })}
    </span>
  );
}

/** 工具状态 → 一个小圆点（颜色即状态；文字进 title，读屏可达） */
function ToolDot({ status }: { status: string }) {
  const label = toolStatusLabel(status);
  const tone = status === "failed" ? "bg-accent-warm" : status === "completed" ? "bg-rule" : "bg-accent-cool";
  return <span role="img" aria-label={label} title={label} className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />;
}

function ToolRow({ item }: { item: ToolItem }) {
  return (
    <li className="flex items-start gap-2">
      <ToolDot status={item.status} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate ${item.status === "failed" ? "text-accent-warm" : "text-ink"}`} title={item.title}>
          {item.title}
        </span>
        <LocationChips locations={item.locations} />
      </div>
    </li>
  );
}

/**
 * 活动组：相邻的工具调用 / 思考折成一行摘要（groupTranscript）。
 * 默认收起——正文才是主角；进行中时摘要行显示当前那条工具，点开看逐条明细与路径。
 */
function ActivityGroup({ items }: { items: Array<{ item: ActivityItem; index: number }> }) {
  const s = summarizeActivity(items);
  const parts = [
    s.tools > 0 ? t("{0} 次工具调用", [s.tools]) : null,
    s.thoughts > 0 ? t("{0} 段思考", [s.thoughts]) : null,
  ].filter(Boolean);
  return (
    <details className="group/act rounded-[3px] border border-rule font-sans text-[12.5px]">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-2.5 py-1.5 text-muted">
        {s.running ? (
          <CircleNotch size={11} className="shrink-0 animate-spin text-accent-cool" aria-hidden />
        ) : (
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.failed > 0 ? "bg-accent-warm" : "bg-rule"}`} />
        )}
        <span className="shrink-0">{parts.join(" · ")}</span>
        {s.failed > 0 && <span className="shrink-0 text-accent-warm">{t("{0} 次失败", [s.failed])}</span>}
        {s.running && <span className="min-w-0 flex-1 truncate text-ink" title={s.running.title}>{s.running.title}</span>}
        {!s.running && s.paths.length > 0 && <span className="min-w-0 flex-1 truncate">{t("涉及 {0} 个文件", [s.paths.length])}</span>}
      </summary>
      <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto border-t border-rule px-2.5 py-2 text-[13px]">
        {items.map(({ item, index }) =>
          item.kind === "tool" ? (
            <ToolRow key={index} item={item} />
          ) : (
            <li key={index} className="whitespace-pre-wrap border-l-2 border-rule pl-2.5 leading-relaxed text-muted">
              {item.text}
            </li>
          ),
        )}
      </ul>
    </details>
  );
}

function Item({ item }: { item: Exclude<TranscriptItem, ActivityItem> }) {
  const agentName = useAgent((s) => s.agentName);
  const openFile = useApp((s) => s.openFile);
  switch (item.kind) {
    case "user": {
      // 随消息附带的文档引用（第二条用户消息）：折成一行，全文点开看
      const ref = referencePath(item.text);
      if (ref !== null)
        return (
          <details className="font-sans text-[12.5px] text-muted">
            <summary className="flex cursor-pointer select-none items-baseline gap-1.5">
              <span className="shrink-0">{t("附带引用")}</span>
              <button className="min-w-0 truncate font-mono text-[12px] text-accent-cool hover:underline" onClick={(e) => { e.preventDefault(); openFile(ref); }}>{ref}</button>
            </summary>
            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap border-l-2 border-rule pl-2.5 leading-relaxed">{item.text}</p>
          </details>
        );
      return (
        <div className="group/msg flex flex-col gap-0.5">
          <span className="font-sans text-[12px] text-muted">{t("你")}</span>
          <p className="whitespace-pre-wrap border-l-2 border-rule pl-2.5 font-sans text-[14px] leading-relaxed text-ink">
            {item.text}
          </p>
        </div>
      );
    }
    case "assistant":
      return (
        <div className="group/msg flex flex-col gap-0.5">
          <span className="font-sans text-[12px] text-muted">{agentName ?? "agent"}</span>
          <div className="prose-reader agent-prose">
            <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
          </div>
        </div>
      );
    case "plan":
      return (
        <ul className="flex flex-col gap-0.5 rounded-[3px] border border-rule px-3 py-2 font-sans text-[13px]">
          {item.entries.map((e, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className="w-8 shrink-0 text-[12px] text-muted">
                {e.status === "completed" ? "✓" : e.status === "in_progress" ? "→" : "·"}
              </span>
              <span className={e.status === "completed" ? "text-muted" : "text-ink"}>
                {e.content}
              </span>
            </li>
          ))}
        </ul>
      );
    case "info":
      return <p className="font-sans text-[12.5px] leading-relaxed text-muted">{item.text}</p>;
  }
}

/** 启动区：预设选择 + 自定义命令（idle/exited/error 态展示） */
function Launcher() {
  const presetId = useAgent((s) => s.presetId);
  const customCmd = useAgent((s) => s.customCmd);
  const setPresetId = useAgent((s) => s.setPresetId);
  const setCustomCmd = useAgent((s) => s.setCustomCmd);
  const status = useAgent((s) => s.status);
  const error = useAgent((s) => s.error);
  const stderrTail = useAgent((s) => s.stderrTail);
  const preset = AGENT_PRESETS.find((p) => p.id === presetId);

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5">
      <label className="flex flex-col gap-1">
        <span className="font-sans text-[13px] text-muted">agent</span>
        <select
          className="rounded-[3px] border border-rule bg-transparent px-2 py-1.5 font-sans text-[14px] text-ink focus:outline-none"
          value={presetId}
          onChange={(e) => setPresetId(e.target.value)}
        >
          {AGENT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === "custom" ? t("自定义命令") : p.label}
            </option>
          ))}
        </select>
      </label>
      {presetId === "custom" ? (
        <label className="flex flex-col gap-1">
          <span className="font-sans text-[13px] text-muted">
            {t("输入 stdio ACP 启动命令，脚本请使用绝对路径。")}
          </span>
          <input
            className="rounded-[3px] border border-rule bg-transparent px-2 py-1.5 font-mono text-[13px] text-ink focus:outline-none"
            value={customCmd}
            onChange={(e) => setCustomCmd(e.target.value)}
            placeholder={t("node /绝对路径/scripts/mock-acp-agent.mjs")}
          />
        </label>
      ) : (
        preset?.note && <p className="font-sans text-[12.5px] text-muted">{t(preset.note)}</p>
      )}
      {error && <p className="font-sans text-[13px] text-accent-warm">{error}</p>}
      {(status === "error" || status === "exited") && stderrTail.length > 0 && (
        <details className="font-sans text-[12.5px] text-muted">
          <summary className="cursor-pointer select-none">{t("诊断输出（stderr）")}</summary>
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-[3px] border border-rule bg-panel p-2 font-mono text-[12px]">
            {stderrTail.join("\n")}
          </pre>
        </details>
      )}
      <div>
        <button className="btn btn-primary !py-1.5" onClick={() => void startSession()}>
          <Play size={13} className="mr-1 inline" aria-hidden />
          {t("启动会话")}
        </button>
      </div>
    </div>
  );
}

/** 握手期间的提示：npx 首次下载适配器可能要一两分钟，把 stderr 最后一行透出来免得像卡死 */
function StartingHint() {
  const stderrTail = useAgent((s) => s.stderrTail);
  const last = stderrTail[stderrTail.length - 1];
  return (
    <p className="font-sans text-[12.5px] leading-relaxed text-muted">
      <CircleNotch size={11} className="mr-1 inline animate-spin" aria-hidden />
      {t("正在启动适配器，首次下载可能需要一两分钟。")}
      {last && <span className="ml-1 font-mono text-[12px]">{last.slice(0, 160)}</span>}
    </p>
  );
}

/**
 * agent 上报的用量（ACP usage_update）。
 * 显示的是**上下文占用**，不是这次会话烧了多少——压缩之后它会掉下去。
 * 累计消耗只有 cost（很多适配器不发），有才显示。
 */
function UsageBar() {
  const usage = useAgent((s) => s.usage);
  if (!usage) return null;
  const pct = contextPercent(usage.used, usage.size);
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b border-rule px-3 py-1 font-sans text-[12px] text-muted"
      title={t("上下文占用，不是本次会话的累计消耗——压缩后会回落。")}
    >
      <span>{t("上下文")}</span>
      <span className="tabular-nums text-ink">{fmtTokens(usage.used)}</span>
      <span>/ {fmtTokens(usage.size)}</span>
      {pct !== null && (
        <>
          <span className="h-1.5 w-16 overflow-hidden rounded-sm bg-rule" aria-hidden>
            <span
              className={`block h-full ${pct >= 85 ? "bg-accent-warm" : "bg-accent-cool/60"}`}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="tabular-nums">{pct}%</span>
        </>
      )}
      {usage.cost && (
        <span className="ml-1">
          {t("· 累计")} <span className="tabular-nums text-ink">{usage.cost.amount.toFixed(2)}</span> {usage.cost.currency}
        </span>
      )}
    </div>
  );
}

/** agent 上报的可用命令 / skills（Claude Code 会把项目 .claude/skills 列在这里） */
function CommandsBar() {
  const commands = useAgent((s) => s.commands);
  if (commands.length === 0) return null;
  return (
    <details className="shrink-0 border-b border-rule px-3 py-1.5 font-sans text-[12.5px] text-muted">
      <summary className="cursor-pointer select-none">{t("可用命令 / skills（{0}）", [commands.length])}</summary>
      <ul className="mt-1 max-h-36 overflow-y-auto">
        {commands.map((c) => (
          <li key={c.name} className="flex min-w-0 gap-2 py-0.5">
            <code className="shrink-0 font-mono text-[12px] text-ink">/{c.name}</code>
            <span className="min-w-0 truncate" title={c.description}>
              {c.description}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function AuthNote() {
  const authNote = useAgent((s) => s.authNote);
  if (!authNote) return null;
  return (
    <p className="shrink-0 border-b border-rule px-3 py-1.5 font-sans text-[12.5px] text-accent-warm">
      {t("agent 未登录（{0}）：先在终端登录，再重启会话", [authNote])}
    </p>
  );
}

function PermissionCard() {
  const permission = useAgent((s) => s.permission);
  if (!permission) return null;
  return (
    <div className="mx-4 mb-2 flex flex-col gap-2 rounded-[3px] border border-rule bg-card px-3 py-2.5 shadow-[var(--shadow-card)]">
      <p className="font-sans text-[13px] text-ink">
        {t("agent 请求执行：")}<span className="text-accent-warm">{permission.title}</span>
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {permission.options.map((o) => (
          <button
            key={o.optionId}
            className={`btn !py-1 !text-[13px] ${o.kind.startsWith("allow") ? "btn-primary" : "btn-outline"}`}
            onClick={() => resolvePermission(o.optionId)}
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 最近结束的一轮改了哪些文档（影子快照比出，见 lib/turn-changes.ts）：点文件名打开，可整轮撤回。
 * 放在对话流末尾当这一轮的结尾，随对话滚动。
 */
function TurnChangesCard() {
  const tc = useAgent((s) => s.turnChanges);
  const undoing = useAgent((s) => s.turnUndoing);
  const status = useAgent((s) => s.status);
  const root = useApp((s) => s.lib?.root);
  const openFile = useApp((s) => s.openFile);
  if (!tc || tc.root !== root || tc.files.length === 0) return null;
  const mark = (s: string) => (s === "added" ? t("新建") : s === "deleted" ? t("已删除") : t("修改"));
  return (
    <div className="flex flex-col gap-1.5 rounded-[3px] border border-rule px-2.5 py-1.5 font-sans text-[12.5px]">
      <div className="flex items-center gap-2 text-muted">
        <span className="flex-1">{t("第 {0} 轮改了 {1} 个文件", [tc.turn, tc.files.length])}</span>
        <button
          className="text-accent-cool hover:underline disabled:opacity-50"
          disabled={undoing || status === "running"}
          title={t("本轮改过的恢复到轮前、新建的移进废纸篓；轮后又被改过的不动")}
          onClick={() => void undoTurn()}
        >
          {undoing ? t("撤回中…") : t("整轮撤回")}
        </button>
      </div>
      <ul className="flex max-h-28 flex-col gap-0.5 overflow-y-auto">
        {tc.files.map((f) => (
          <li key={f.path} className="flex min-w-0 items-baseline gap-2 font-sans text-[12.5px]">
            <span className="shrink-0 text-muted">{mark(f.status)}</span>
            {f.status === "deleted" ? (
              <span className="min-w-0 truncate font-mono text-[12px] text-muted">{f.path}</span>
            ) : (
              <button className="min-w-0 truncate font-mono text-[12px] text-accent-cool hover:underline" onClick={() => openFile(f.path)}>
                {f.path}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AuthCard() {
  const authMethods = useAgent((s) => s.authMethods);
  return (
    <div className="mx-4 mb-2 flex flex-col gap-2 rounded-[3px] border border-rule bg-card px-3 py-2.5">
      <p className="font-sans text-[13px] text-ink">{t("该 agent 要求登录")}</p>
      <div className="flex flex-wrap gap-1.5">
        {authMethods.map((m) => (
          <button
            key={m.id}
            className="btn btn-outline !py-1 !text-[13px]"
            title={m.description ?? undefined}
            onClick={() => void authenticate(m.id)}
          >
            {m.name}
          </button>
        ))}
      </div>
      <p className="font-sans text-[12.5px] text-muted">
        {t("或先在终端完成该 CLI 的登录，再回来重启会话。")}
      </p>
    </div>
  );
}

function ArchiveBar() {
  const archive = useAgent((s) => s.archive);
  const openFile = useApp((s) => s.openFile);
  return (
    <details open={archive?.status === "error" ? true : undefined} className="shrink-0 border-b border-rule px-3 py-1.5 font-sans text-[12px] text-muted">
      <summary className={`cursor-pointer ${archive?.status === "error" ? "text-accent-warm" : ""}`} role="status">
        {archive?.status === "saved" ? t("会话已保存") : archive?.status === "error" ? t("会话保存失败") : archive ? t("会话保存中…") : t("会话自动保存")}
      </summary>
      <p className="mt-1 leading-relaxed">{!archive
        ? t("用户与回复正文自动保存，不保存思考与工具原始数据。文件夹是文库（有 .openfile/）时存进 会话/内嵌/，否则存在 Openfile 的应用数据目录。")
        : archive.inLibrary
          ? t("用户与回复正文自动保存到当前文库，会随文库同步；不保存思考与工具原始数据。")
          : t("这个文件夹还不是文库，正文存在 Openfile 的应用数据目录，不写进文件夹；不保存思考与工具原始数据。")}</p>
      {archive && <div className="mt-1 flex flex-wrap items-center gap-2">
        {archive.savedAt !== null && (archive.inLibrary
          ? <button className="break-all text-accent-cool hover:underline" onClick={() => openFile(archive.path)}>{archive.path}</button>
          : <span className="break-all">{t("应用数据目录 · {0}", [archive.path])}</span>)}
        {archive.status === "error" && <><span className="break-all text-accent-warm">{archive.error}</span><button className="btn btn-outline !py-1 !text-[12px]" onClick={() => void flushSessionArchive()}>{t("重试保存")}</button></>}
      </div>}
    </details>
  );
}

function HistoryPanel({ onClose }: { onClose: () => void }) {
  const root = useApp((s) => s.lib?.root);
  const openFile = useApp((s) => s.openFile);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SessionHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limited, setLimited] = useState(false);
  const [revision, setRevision] = useState(0);
  const [exporting, setExporting] = useState<"all" | "folder" | null>(null);
  const [exportOutput, setExportOutput] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ConversationExportResult | null>(null);
  const exportChats = async (scope: "all" | "folder") => {
    if (!root || exporting) return;
    setExporting(scope); setExportOutput(null); setExportResult(null);
    try {
      const result = await backend.exportConversations(scope, root);
      if (useApp.getState().lib?.root === root) {
        if (result.summary) setExportResult(result);
        else setExportOutput(result.output || t("导出完成，没有输出。"));
      }
    } catch (e) {
      if (useApp.getState().lib?.root === root) setExportOutput(String(e));
    } finally {
      setExporting(null);
    }
  };
  const openArchive = async () => {
    try {
      const dir = await backend.conversationsRoot();
      if (canOpenWindows) await openLibraryWindow(dir);
      else await useApp.getState().setLibraryPath(dir);
    } catch (e) {
      setExportOutput(String(e));
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    setItems([]); setError(null); setBusy(true);
    const timer = setTimeout(() => {
      if (!root) { setBusy(false); return; }
      void searchSessionHistory(backend, root, query, controller.signal).then((result) => {
        if (!controller.signal.aborted && useApp.getState().lib?.root === root) { setItems(result.items); setLimited(result.limited); }
      }).catch((e) => {
        if (!controller.signal.aborted && useApp.getState().lib?.root === root) setError(String(e));
      }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [root, query, revision]);
  return <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3 font-sans text-[13px]" aria-label={t("会话历史")}>
    <div className="flex items-center justify-between"><span className="text-ink">{t("当前文库的会话历史")}</span><button className="btn btn-outline !py-1 !text-[12px]" onClick={onClose}>{t("返回会话")}</button></div>
    <p className="text-[12px] leading-relaxed text-muted">{t("检索本文库的内嵌与导入档案。")}</p>
    <p className="text-[12px] leading-relaxed text-muted">{t("导出对话：把本机各家 CLI 的对话转成 Markdown，统一存进 Openfile 主文件夹（~/.openfile），按项目归档、自动脱敏；不往这个文件夹写任何东西，不调用模型，也不联网。")}</p>
    <div className="flex flex-wrap items-center gap-2">
      <button className="btn btn-outline !py-1 !text-[12px]" disabled={!root || !!exporting} onClick={() => void exportChats("folder")}>{exporting === "folder" ? t("正在导出…") : t("只导出当前文件夹对话")}</button>
      <button className="btn btn-outline !py-1 !text-[12px]" disabled={!root || !!exporting} onClick={() => void exportChats("all")}>{exporting === "all" ? t("正在导出…") : t("导出所有对话")}</button>
      <button className="btn btn-outline !py-1 !text-[12px]" onClick={() => void openArchive()}>{t("打开主文件夹")}</button>
    </div>
    {exportResult?.summary && <div role="status" className="flex flex-col gap-1 rounded-[3px] border border-rule px-2 py-1.5 text-[12px] text-muted">
      {exportResult.summary.found
        ? <p>{t("完成：导出 {0}，刷新 {1}，跳过 {2}。", [exportResult.summary.exported, exportResult.summary.refreshed, exportResult.summary.skipped])}</p>
        : <p>{t("没有发现可导出的对话。")}</p>}
      {exportResult.summary.outside > 0 && <p>{t("其中 {0} 份属于其他文件夹或缺少来源，用「导出所有对话」可以一并导出。", [exportResult.summary.outside])}</p>}
      {exportResult.summary.redactions > 0 && <p>{t("已自动脱敏 {0} 处。", [exportResult.summary.redactions])}</p>}
      {exportResult.summary.suspects > 0 && <p className="text-accent-warm">{t("另有 {0} 条疑似密钥的长串没有替换，分享档案前请人工过目。", [exportResult.summary.suspects])}</p>}
      <details><summary className="cursor-pointer">{t("详细输出")}</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">{exportResult.output}</pre></details>
    </div>}
    {exportOutput && <pre role="status" className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[3px] border border-rule px-2 py-1.5 text-[12px] text-muted">{exportOutput}</pre>}
    <div className="flex gap-2"><input className="min-w-0 flex-1 rounded-[3px] border border-rule bg-transparent px-2 py-1.5 text-ink" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("搜索文件名或会话正文")} aria-label={t("搜索会话历史")} /><button className="btn btn-outline !py-1 !text-[12px]" onClick={() => setRevision((r) => r + 1)}>{t("刷新")}</button></div>
    <p className="text-[12px] text-muted">{t("最多检索最近 2000 份档案，每份正文前 256 KiB，显示前 200 条结果。")}</p>
    {limited && <p className="text-[12px] text-accent-warm">{t("结果或正文达到检索上限，可缩小关键词范围并打开原文。")}</p>}
    {busy && <p role="status" className="text-muted">{t("正在检索会话…")}</p>}
    {error && <p role="alert" className="text-accent-warm">{error}</p>}
    {!busy && !error && !items.length && <p className="text-muted">{t("当前文库暂无匹配的会话档案。")}</p>}
    {items.map((item) => <article key={`${item.appData ? "app:" : ""}${item.path}`} className="flex flex-col gap-1.5 border-b border-rule py-2">
      {item.appData
        ? <span className="text-[14px] text-ink">{item.title}</span>
        : <button className="text-left text-[14px] text-ink hover:underline" onClick={() => openFile(item.path)}>{item.title}</button>}
      <p className="break-all text-[12px] text-muted">{item.appData ? t("应用数据目录 · {0}", [item.path]) : item.path}</p>
      {item.excerpt && <p className="text-[13px] text-muted">{item.excerpt}</p>}
      <div className="flex flex-wrap gap-2">{!item.appData && <button className="btn btn-outline !py-1 !text-[12px]" onClick={() => openFile(item.path)}>{t("打开原文")}</button>}<button className="btn btn-outline !py-1 !text-[12px]" onClick={async () => {
        await startSessionFromHistory(item.path, item.appData);
        if (useApp.getState().lib?.root === root && useAgent.getState().historyContext?.path === item.path) onClose();
      }}>{t("以历史上下文新建会话")}</button></div>
    </article>)}
    <p className="text-[12px] leading-relaxed text-muted">{t("历史恢复会结束当前会话并创建新会话；引用开头最多 24000 字符，发送下一条消息时才提供给 agent，不是原生会话恢复。")}</p>
  </section>;
}

function ContextBar() {
  const history = useAgent((s) => s.historyContext);
  const sources = useAgent((s) => s.contextSources);
  const openFile = useApp((s) => s.openFile);
  // 只在有待引用历史或本轮引用来源时出现；当前文件自动附带，不在这里显示
  if (!history && sources.length === 0) return null;
  return <div className="shrink-0 border-b border-rule px-3 py-2 font-sans text-[12px] text-muted">
    {history && <div className="flex items-start justify-between gap-2"><span className="break-all">{t("待引用历史：{0}", [history.appData ? t("应用数据目录 · {0}", [history.path]) : history.path])}{history.truncated && t("（开头节选）")}</span><button className="shrink-0 hover:underline" onClick={() => useAgent.setState({ historyContext: null })}>{t("移除引用")}</button></div>}
    {sources.length > 0 && <details className={history ? "mt-1" : ""}><summary className="cursor-pointer">{t("本轮引用来源（{0}）", [sources.length])}</summary>{sources.map((path) => <button key={path} className="mt-1 block max-w-full truncate text-accent-cool hover:underline" onClick={() => openFile(path)}>{path}</button>)}</details>}
  </div>;
}

export function AgentPanel() {
  const status = useAgent((s) => s.status);
  const transcript = useAgent((s) => s.transcript);
  const agentName = useAgent((s) => s.agentName);
  const modes = useAgent((s) => s.modes);
  const setPanelOpen = useAgent((s) => s.setPanelOpen);
  const [draft, setDraft] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const root = useApp((s) => s.lib?.root);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const turnChanges = useAgent((s) => s.turnChanges);
  useEffect(() => { setDraft(""); setShowHistory(false); }, [root]);

  // 自动跟底：仅当用户本就贴底时（读旧消息不被拽走）；轮末的改动卡片晚于转写到达，也跟一次
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [transcript, turnChanges]);

  const live = status === "ready" || status === "running" || status === "auth" || status === "starting";
  const blocks = useMemo(() => groupTranscript(transcript), [transcript]);
  const send = () => {
    const text = draft.trim();
    if (text === "" || status !== "ready") return;
    stickBottom.current = true;
    sendPrompt(text);
    setDraft("");
  };

  return (
    <aside className="relative flex min-h-0 flex-col border-l border-rule" aria-label={t("agent 会话面板")}>
      <PanelResizer which="agent" />
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-rule px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              status === "ready" || status === "running"
                ? "bg-accent-cool"
                : status === "error"
                  ? "bg-accent-warm"
                  : "bg-rule"
            }`}
          />
          <span className="truncate font-sans text-[13px] text-ink">
            {agentName ?? t("agent 会话")}
          </span>
          <span className="shrink-0 font-sans text-[12px] text-muted">
            {status === "starting" && <CircleNotch size={11} className="inline animate-spin" aria-hidden />}{" "}
            {statusLabel(status)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button className="icon-btn !h-5 !w-auto px-1.5 text-[12px]" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>{t("历史")}</button>
          {modes && modes.availableModes.length > 1 && (
            <select
              className="max-w-[96px] rounded-[2px] border border-rule bg-transparent px-1 py-0.5 font-sans text-[12px] text-muted focus:outline-none"
              value={modes.currentModeId}
              onChange={(e) => setSessionMode(e.target.value)}
              title={t("会话模式")}
              aria-label={t("会话模式")}
            >
              {modes.availableModes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          {live && (
            <button
              className="icon-btn !h-5 !w-auto px-1.5 text-[12px]"
              onClick={() => void stopSession()}
              title={t("结束会话（终止 agent 进程）")}
            >
              {t("结束")}
            </button>
          )}
          <button
            className="icon-btn !h-5 !w-5"
            aria-label={t("收起会话面板")}
            title={t("收起（{0}J）", [MOD])}
            onClick={() => setPanelOpen(false)}
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </header>
      <ArchiveBar />
      <AuthNote />
      <CommandsBar />
      <UsageBar />
      <ContextBar />

      {showHistory ? <HistoryPanel onClose={() => setShowHistory(false)} /> : <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {transcript.length === 0 && status === "idle" && (
          <p className="font-sans text-[13px] leading-relaxed text-muted">
            {t("向 agent 提问，会自动带上当前打开的文件。")}
          </p>
        )}
        {blocks.map((block) =>
          block.kind === "activity" ? (
            <ActivityGroup key={`a${block.items[0].index}`} items={block.items} />
          ) : (
            <Item key={block.index} item={block.item} />
          ),
        )}
        {status === "starting" && <StartingHint />}
        <TurnChangesCard />
      </div>}

      {status === "auth" && <AuthCard />}
      <PermissionCard />

      {live ? (
        <footer className="shrink-0 border-t border-rule px-3 py-2.5">
          <div className="flex items-end gap-1.5">
            <textarea
              className="max-h-32 min-h-[34px] flex-1 resize-none rounded-[3px] border border-rule bg-transparent px-2.5 py-1.5 font-sans text-[14px] leading-relaxed text-ink focus:outline-none"
              rows={Math.min(5, Math.max(1, draft.split("\n").length))}
              placeholder={status === "ready" ? t("对 agent 说……（Enter 发送）") : t("这一轮进行中…")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // 中文输入法组合态的回车是选字，不是发送
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {status === "running" ? (
              <button
                className="icon-btn !h-[34px] !w-[34px] shrink-0 border border-rule"
                aria-label={t("停止这一轮")}
                title={t("停止这一轮")}
                onClick={cancelTurn}
              >
                <Stop size={14} aria-hidden />
              </button>
            ) : (
              <button
                className="icon-btn !h-[34px] !w-[34px] shrink-0 border border-rule"
                aria-label={t("发送")}
                title={t("发送（Enter）")}
                onClick={send}
                disabled={status !== "ready"}
              >
                <ArrowUp size={14} aria-hidden />
              </button>
            )}
          </div>
        </footer>
      ) : (
        <Launcher />
      )}
    </aside>
  );
}
