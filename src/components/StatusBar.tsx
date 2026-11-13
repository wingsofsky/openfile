import {
  ChatCircleText,
  ClockCounterClockwise,
  Minus,
  Moon,
  Plus,
  Sun,
} from "@phosphor-icons/react";
import { useApp } from "../state/store";
import { useAgent } from "../state/agent";
import { backend } from "../lib/backend";
import { getLocale, LOCALE_TOGGLE_LABEL, setLocale, t } from "../i18n";
import { MOD } from "../lib/util";

/** 右侧：版本与会话 */
export function StatusBar() {
  const lib = useApp((s) => s.lib);
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const adjustFont = useApp((s) => s.adjustFont);
  const fontScale = useApp((s) => s.fontScale);
  const toggleTimeline = useApp((s) => s.toggleTimeline);
  const timelineOpen = useApp((s) => s.timelineOpen);
  const agentPanelOpen = useAgent((s) => s.panelOpen);
  const setPanelOpen = useAgent((s) => s.setPanelOpen);
  const agentLive = useAgent((s) => s.status === "ready" || s.status === "running");
  const openNotice = useApp((s) => s.openNotice);
  const dismissOpenNotice = useApp((s) => s.dismissOpenNotice);

  return (
    <footer className="flex h-7 items-center justify-between border-t border-rule bg-panel px-3 text-[13px] text-muted">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate" title={lib?.root ?? ""}>
          {lib ? lib.root : t("未选择文库")}
        </span>
        {backend.kind === "dev" && (
          <span className="shrink-0 rounded-[2px] border border-rule px-1 text-[12px]">
            {t("浏览器开发模式")}
          </span>
        )}
        <span className="shrink-0 text-[12px] opacity-60" title={t("构建时间（排查版本用）")}>
          {__OPENFILE_BUILD__}
        </span>
        {openNotice && (
          <button className="min-w-0 truncate text-[12.5px] text-accent-warm" title={t("点击关闭")} onClick={dismissOpenNotice}>
            {openNotice}
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          className={`icon-btn !h-5 !w-auto px-1.5 text-[12.5px] ${timelineOpen ? "!text-accent-cool" : ""}`}
          onClick={toggleTimeline}
          title={t("版本时间线（{0}Y）", [MOD])}
        >
          <ClockCounterClockwise size={13} aria-hidden />
          <span className="ml-1">{t("版本")}</span>
        </button>
        {lib && (
          <button
            className={`icon-btn !h-5 !w-auto px-1.5 text-[12.5px] ${agentPanelOpen ? "!text-accent-cool" : ""}`}
            onClick={() => setPanelOpen(!agentPanelOpen)}
            title={t("agent 会话面板（{0}J）", [MOD])}
            aria-expanded={agentPanelOpen}
          >
            <ChatCircleText size={13} aria-hidden />
            <span className="ml-1">{t("会话")}</span>
            {agentLive && !agentPanelOpen && (
              <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent-cool" aria-hidden />
            )}
          </button>
        )}
        <span className="mx-1 h-3.5 w-px bg-rule" aria-hidden />
        <button
          className="icon-btn !h-5 !w-auto px-1.5 text-[12.5px] tabular-nums"
          aria-label={t("切换界面语言")}
          title={t("切换界面语言")}
          onClick={() => setLocale(getLocale() === "zh" ? "en" : "zh")}
        >
          {LOCALE_TOGGLE_LABEL[getLocale()]}
        </button>
        <span className="mx-1 h-3.5 w-px bg-rule" aria-hidden />
        <button className="icon-btn !h-5 !w-5" aria-label={t("缩小正文字号")} title={t("缩小正文字号")} onClick={() => adjustFont(-0.05)}>
          <Minus size={12} aria-hidden />
        </button>
        <span className="w-9 text-center tabular-nums">{Math.round(fontScale * 100)}%</span>
        <button className="icon-btn !h-5 !w-5" aria-label={t("放大正文字号")} title={t("放大正文字号")} onClick={() => adjustFont(0.05)}>
          <Plus size={12} aria-hidden />
        </button>
        <span className="mx-1 h-3.5 w-px bg-rule" aria-hidden />
        <button
          className="icon-btn !h-5 !w-5"
          aria-label={theme === "paper" ? t("切换到墨夜主题") : t("切换到纸页主题")}
          title={theme === "paper" ? t("墨夜") : t("纸页")}
          onClick={toggleTheme}
        >
          {theme === "paper" ? <Moon size={13} aria-hidden /> : <Sun size={13} aria-hidden />}
        </button>
      </div>
    </footer>
  );
}
