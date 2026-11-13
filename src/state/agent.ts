/**
 * agent 会话的 UI 状态（zustand）。只存可渲染状态；
 * 会话生命周期与协议接线在 src/lib/agent-controller.ts（模块级单例，
 * 不进 React 生命周期——StrictMode 双挂载与热更不打断进程）。
 */
import { create } from "zustand";
import { ACP_PRESETS } from "@openfile/protocol/executor-registry";
import type { TranscriptItem } from "../lib/acp";
import type { ArchiveState } from "../lib/session-history";
import type { TurnChanges } from "../lib/turn-changes";
import { prefs } from "../lib/prefs";

type AgentStatus =
  | "idle" // 无会话
  | "starting" // 进程已起，握手中
  | "auth" // agent 要求登录
  | "ready" // 可发话
  | "running" // 一轮进行中
  | "exited" // 进程退出（保留转写）
  | "error"; // 协议/启动失败（保留诊断）

interface AgentPreset {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  note?: string;
}

/** 会话面板默认的预设（找不到已存的预设时也退回它） */
const DEFAULT_PRESET = "claude";

/**
 * 预设按适配器现状 pin：来自执行者登记表的 acp 字段（id 与登记表一致）；
 * 默认预设排第一，「自定义」走完整命令行输入
 */
export const AGENT_PRESETS: AgentPreset[] = [
  ...ACP_PRESETS.filter((p) => p.id === DEFAULT_PRESET),
  ...ACP_PRESETS.filter((p) => p.id !== DEFAULT_PRESET),
  { id: "custom", label: "自定义命令", cmd: "", args: [] },
];

export interface PermissionAsk {
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

/**
 * agent 上报的用量（ACP usage_update）。
 * **注意 used 是「当前上下文里有多少 token」，不是「这次会话烧了多少」**——压缩之后它会掉下去。
 * 真正的累计消耗只有 cost（可选，很多适配器不发）。别把 used 当消费计量显示。
 */
interface UsageState {
  /** 当前上下文占用 */
  used: number;
  /** 上下文窗口总量 */
  size: number;
  /** 累计花费（agent 报了才有） */
  cost: { amount: number; currency: string } | null;
}

interface ModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string }>;
}

interface AgentUiState {
  panelOpen: boolean;
  status: AgentStatus;
  presetId: string;
  customCmd: string;
  /** initialize 返回的 agent 名（展示用；未知时用预设 label） */
  agentName: string | null;
  transcript: TranscriptItem[];
  /** 队首待决的权限请求（余下的排在控制器队列里） */
  permission: PermissionAsk | null;
  modes: ModeState | null;
  authMethods: Array<{ id: string; name: string; description?: string | null }>;
  error: string | null;
  /** 诊断：stderr 尾部若干行（启动失败/异常退出时展示） */
  stderrTail: string[];
  /** agent 上报的可用命令 / skills（available_commands_update；Claude Code 会把 .claude/skills 列在这里） */
  commands: Array<{ name: string; description: string }>;
  /** agent 经 _auth/status_update 报告「未登录」时的标签；null = 未报告或已登录 */
  authNote: string | null;
  /** agent 上报的上下文占用与累计花费（usage_update）；null = 没报过 */
  usage: UsageState | null;
  archive: ArchiveState | null;
  /** Explicitly selected history, used only for the first prompt of a new session. */
  historyContext: { root: string; path: string; content: string; truncated: boolean; appData?: boolean } | null;
  contextSources: string[];
  /** 最近一轮（已结束）改了哪些文件；null = 还没有结束的轮、没拍到基线或已撤回（见 lib/turn-changes.ts） */
  turnChanges: TurnChanges | null;
  /** 整轮撤回进行中 */
  turnUndoing: boolean;

  setPanelOpen(v: boolean): void;
  setPresetId(id: string): void;
  setCustomCmd(cmd: string): void;
}

const PRESET_KEY = "openfile:agentPreset";
const CUSTOM_KEY = "openfile:agentCustomCmd";

export const useAgent = create<AgentUiState>((set) => ({
  panelOpen: false,
  status: "idle",
  presetId:
    AGENT_PRESETS.some((p) => p.id === prefs.get(PRESET_KEY))
      ? (prefs.get(PRESET_KEY) as string)
      : DEFAULT_PRESET,
  customCmd: prefs.get(CUSTOM_KEY) ?? "",
  agentName: null,
  transcript: [],
  permission: null,
  modes: null,
  authMethods: [],
  error: null,
  stderrTail: [],
  commands: [],
  authNote: null,
  usage: null,
  archive: null,
  historyContext: null,
  contextSources: [],
  turnChanges: null,
  turnUndoing: false,

  setPanelOpen: (v) => set({ panelOpen: v }),
  setPresetId: (id) => {
    prefs.set(PRESET_KEY, id);
    set({ presetId: id });
  },
  setCustomCmd: (cmd) => {
    prefs.set(CUSTOM_KEY, cmd);
    set({ customCmd: cmd });
  },
}));
