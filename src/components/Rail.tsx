import { useEffect, useRef, useState } from "react";
import { AppWindow, ArrowsClockwise, CaretDown, FolderSimple } from "@phosphor-icons/react";
import { useApp } from "../state/store";
import { backend } from "../lib/backend";
import { canOpenWindows, openLibraryWindow } from "../lib/windows";
import type { RecentLibrary } from "../lib/types";
import { Tree } from "./Tree";
import { TreeNotice } from "./TreeMenu";
import { PanelResizer } from "./PanelResizer";
import { t } from "../i18n";

export function Rail({ hidden = false }: { hidden?: boolean }) {
  const lib = useApp((s) => s.lib);
  const indexCount = useApp((s) => s.indexCount);

  if (!lib) return null;
  return (
    <aside className={`relative min-h-0 flex-col border-r border-rule bg-panel ${hidden ? "hidden" : "flex"}`} aria-hidden={hidden}>
      <PanelResizer which="rail" />
      <header className="flex items-center gap-2 border-b border-rule px-3 py-2.5">
        <FolderSimple size={16} className="shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-ink" title={lib.root}>
            {lib.name}
          </p>
          <p className="truncate text-[12.5px] text-muted">
            {indexCount === null ? t("正在索引…") : t("{0} 个文件", [indexCount.toLocaleString()])}
          </p>
        </div>
        <button
          className="icon-btn"
          title={t("重建索引")}
          aria-label={t("重建索引")}
          onClick={() => void backend.rebuildIndex()}
        >
          <ArrowsClockwise size={14} aria-hidden />
        </button>
        <SwitchMenu />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pt-1.5">
        {/* key=root：切库时整树重挂载，绝不残留上一库的目录缓存 */}
        <Tree key={lib.root} />
      </div>
      <TreeNotice />
    </aside>
  );
}

/** 切换文库：最近列表 + 选择新文件夹 */
function SwitchMenu() {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<RecentLibrary[]>([]);
  const lib = useApp((s) => s.lib);
  const chooseLibrary = useApp((s) => s.chooseLibrary);
  const setLibraryPath = useApp((s) => s.setLibraryPath);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) backend.getRecents().then(setRecents).catch(() => setRecents([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className="icon-btn !w-auto gap-0.5 px-1"
        title={t("切换文库")}
        aria-label={t("切换文库")}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <FolderSimple size={14} weight="bold" aria-hidden />
        <CaretDown size={9} aria-hidden />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-40 w-64 rounded-[4px] border border-rule bg-card py-1 shadow-[var(--shadow-card)]">
          <p className="px-3 py-1 font-sans text-[12px] tracking-wide text-muted">{t("最近文库")}</p>
          {recents.filter((r) => r.exists).length === 0 && (
            <p className="px-3 py-1 text-[13px] text-muted">{t("（暂无）")}</p>
          )}
          {recents
            .filter((r) => r.exists)
            .map((r) => (
              <div key={r.root} className="flex items-center hover:bg-[var(--hover-surface)]">
                <button
                  className={`block min-w-0 flex-1 truncate px-3 py-1.5 text-left text-[13.5px] ${
                    r.root === lib?.root ? "text-muted" : "text-ink"
                  }`}
                  title={r.root}
                  disabled={r.root === lib?.root}
                  onClick={() => {
                    setOpen(false);
                    void setLibraryPath(r.root);
                  }}
                >
                  {r.name}
                  {r.root === lib?.root ? t("（当前）") : ""}
                </button>
                {canOpenWindows && r.root !== lib?.root && (
                  <button
                    className="icon-btn mr-1 shrink-0"
                    title={t("在新窗口中打开")}
                    aria-label={t("在新窗口中打开")}
                    onClick={() => {
                      setOpen(false);
                      void openLibraryWindow(r.root);
                    }}
                  >
                    <AppWindow size={14} aria-hidden />
                  </button>
                )}
              </div>
            ))}
          <div className="mt-1 border-t border-rule pt-1">
            <button
              className="block w-full px-3 py-1.5 text-left text-[13.5px] text-accent-cool hover:bg-[var(--hover-surface)]"
              onClick={() => {
                setOpen(false);
                void chooseLibrary();
              }}
            >
              {t("选择新文件夹…")}
            </button>
            {canOpenWindows && (
              <button
                className="block w-full px-3 py-1.5 text-left text-[13.5px] text-accent-cool hover:bg-[var(--hover-surface)]"
                onClick={() => {
                  setOpen(false);
                  void openLibraryWindow();
                }}
              >
                {t("在新窗口中打开文件夹…")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
