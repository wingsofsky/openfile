import { GitDiff, Keyboard, SidebarSimple, X } from "@phosphor-icons/react";
import { useApp } from "../state/store";
import { baseName } from "../lib/util";
import { t, t as tr } from "../i18n";
import { MOD } from "../lib/util";

export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeId);
  const setActive = useApp((s) => s.setActive);
  const closeTab = useApp((s) => s.closeTab);

  if (tabs.length === 0) {
    return (
      <div className="flex h-9 items-center gap-2 border-b border-rule px-1.5 text-[13px] text-muted">
        <RailToggle />
        <span className="px-2.5">{t("从左侧选择文件，或 {0}P 快速打开", [MOD])}</span>
      </div>
    );
  }

  return (
    <div className="flex h-9 items-end gap-0.5 overflow-x-auto border-b border-rule px-1.5" role="tablist">
      <div className="flex h-[30px] shrink-0 items-center pr-1">
        <RailToggle />
      </div>
      {tabs.map((t) => {
        const active = t.id === activeId;
        const label =
          t.kind === "spike"
            ? tr("IME 试验场")
            : t.kind === "diff"
              ? tr("对比 · {0}", [baseName(t.rel)])
              : baseName(t.rel);
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            className={`group flex h-[30px] max-w-56 min-w-0 cursor-pointer items-center gap-1.5 rounded-t-[3px] border-b-2 px-2.5 text-[13.5px] ${
              active
                ? "border-ink font-medium text-ink"
                : "border-transparent text-muted hover:bg-[var(--hover-surface)] hover:text-ink"
            }`}
            title={t.rel || label}
            onClick={() => setActive(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id);
            }}
          >
            {t.kind === "spike" && <Keyboard size={13} aria-hidden className="shrink-0" />}
            {t.kind === "diff" && <GitDiff size={13} aria-hidden className="shrink-0" />}
            <span className="truncate">{label}</span>
            <button
              className="icon-btn !h-4 !w-4 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={tr("关闭 {0}", [label])}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              <X size={11} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** 文库栏开关：常驻 tab 栏左端，收起后仍能展开（{MOD}B 同效） */
function RailToggle() {
  const collapsed = useApp((s) => s.railCollapsed);
  const toggleRail = useApp((s) => s.toggleRail);
  const label = collapsed ? t("展开文库栏（{0}B）", [MOD]) : t("收起文库栏（{0}B）", [MOD]);
  return (
    <button
      className="icon-btn shrink-0"
      aria-label={label}
      title={label}
      aria-pressed={!collapsed}
      onClick={toggleRail}
    >
      <SidebarSimple size={15} weight={collapsed ? "regular" : "fill"} aria-hidden />
    </button>
  );
}
