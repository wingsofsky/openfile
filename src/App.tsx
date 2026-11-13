import { useEffect, useSyncExternalStore } from "react";
import { useApp } from "./state/store";
import { useAgent } from "./state/agent";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AgentPanel } from "./components/AgentPanel";
import { Rail } from "./components/Rail";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { QuickOpen } from "./components/QuickOpen";
import { Timeline } from "./components/Timeline";
import { ViewerHost } from "./viewers/ViewerHost";
import { Welcome } from "./components/Welcome";
import { getLocale, subscribeLocale } from "./i18n";
import { backend } from "./lib/backend";

export default function App() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  const init = useApp((s) => s.init);
  const lib = useApp((s) => s.lib);
  const activeId = useApp((s) => s.activeId);
  const libLoading = useApp((s) => s.libLoading);
  const fontScale = useApp((s) => s.fontScale);
  const setQuickOpen = useApp((s) => s.setQuickOpen);
  const closeTab = useApp((s) => s.closeTab);
  const agentPanelOpen = useAgent((s) => s.panelOpen);
  const railCollapsed = useApp((s) => s.railCollapsed);
  const railWidth = useApp((s) => s.railWidth);
  const agentWidth = useApp((s) => s.agentWidth);

  // 系统对话框标题由原生端出：界面语言只在前端，启动和每次切换时告诉它
  useEffect(() => {
    if (backend.kind !== "tauri") return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_locale", { locale })).catch(() => {});
  }, [locale]);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpen(true);
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        useApp.getState().toggleTimeline();
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useApp.getState().toggleRail();
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        useAgent.getState().setPanelOpen(!useAgent.getState().panelOpen);
      }
      if (mod && e.key.toLowerCase() === "w") {
        const { activeId } = useApp.getState();
        if (activeId) {
          e.preventDefault();
          closeTab(activeId);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setQuickOpen, closeTab]);

  if (libLoading) return null;

  // 根网格的列必须写成 minmax(0,1fr)：隐式 1fr 等于 minmax(auto,1fr)，会被状态栏里 truncate 的长文库路径撑宽，
  // 整个布局跟着出视口。下面两侧栏之间的中间列、main 自己的列同理（docx 的固定纸宽会撑开 auto 列）。
  return (
    <div
      key={locale}
      className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[1fr_auto]"
      style={{ "--prose-scale": fontScale } as React.CSSProperties}
    >
      {lib ? (
        <div
          className="grid min-h-0"
          style={{
            // 宽度可拖（PanelResizer）；min(…vw) 兜住窗口缩小时正文列被两侧栏挤没（两栏合计 ≤70vw）
            gridTemplateColumns: [
              !railCollapsed && `min(${railWidth}px, 30vw)`,
              "minmax(0,1fr)",
              agentPanelOpen && `min(${agentWidth}px, 40vw)`,
            ]
              .filter(Boolean)
              .join(" "),
          }}
        >
          {/* 收起用 display:none 而不是卸载：Tree 的目录展开态是组件本地 state，卸了就丢 */}
          <Rail hidden={railCollapsed} />
          <main className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] overflow-hidden">
            <TabBar />
            {/* key=activeId：切 tab 自动走出错误态 */}
            <ErrorBoundary key={activeId ?? "none"}>
              <ViewerHost />
            </ErrorBoundary>
            <Timeline />
          </main>
          {agentPanelOpen && <AgentPanel />}
        </div>
      ) : (
        <Welcome />
      )}
      <StatusBar />
      <QuickOpen />
    </div>
  );
}
