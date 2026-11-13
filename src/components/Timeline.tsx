import { useCallback, useEffect, useState } from "react";
import {
  ArrowCounterClockwise,
  Camera,
  CaretRight,
  FilePlus,
  FileX,
  PencilSimple,
  X,
} from "@phosphor-icons/react";
import { backend } from "../lib/backend";
import type { FileChange, SnapshotInfo } from "../lib/types";
import { useApp } from "../state/store";
import { formatRelTime } from "../lib/time";
import { t } from "../i18n";

export function Timeline() {
  const open = useApp((s) => s.timelineOpen);
  const toggle = useApp((s) => s.toggleTimeline);
  const tick = useApp((s) => s.snapshotTick);
  const [items, setItems] = useState<SnapshotInfo[]>([]);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    backend
      .listSnapshots(100)
      .then((s) => {
        setItems(s);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();
    backend.getAutoSnapshot().then(setAuto).catch(() => {});
  }, [open, tick, refresh]);

  if (!open) return null;

  const snapNow = async () => {
    setBusy(true);
    setNote(null);
    try {
      const info = await backend.snapshotNow();
      setNote(info ? t("已快照 {0}（{1} 个文件变更）", [info.id, info.filesChanged]) : t("没有变化，无需快照"));
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      className="absolute inset-y-0 right-0 z-30 flex w-[400px] max-w-[85vw] flex-col border-l border-rule bg-panel"
      aria-label={t("版本时间线")}
    >
      <header className="flex items-center gap-2 border-b border-rule px-3.5 py-2.5">
        <p className="min-w-0 flex-1 text-[14px] font-semibold text-ink">{t("版本时间线")}</p>
        <button
          className="btn btn-outline !py-1 !text-[13px]"
          onClick={() => void snapNow()}
          disabled={busy}
        >
          <Camera size={13} className="mr-1 inline" aria-hidden />
          {busy ? t("快照中…") : t("立即快照")}
        </button>
        <button
          className={`btn !py-1 !text-[13px] ${auto ? "text-accent-cool" : "text-muted"}`}
          title={t("文件变更后安静 45 秒自动快照")}
          onClick={() => {
            const v = !auto;
            setAuto(v);
            void backend.setAutoSnapshot(v);
          }}
        >
          {t("自动：")}{auto ? t("开") : t("关")}
        </button>
        <button className="icon-btn" aria-label={t("关闭时间线")} onClick={toggle}>
          <X size={14} aria-hidden />
        </button>
      </header>
      {note && <p className="border-b border-rule px-3.5 py-1.5 text-[13px] text-accent-cool">{note}</p>}
      {error && <p className="border-b border-rule px-3.5 py-1.5 text-[13px] text-accent-warm">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && !error && (
          <p className="px-4 py-6 text-[13.5px] leading-relaxed text-muted">
            {t("还没有快照。点「立即快照」记录当前状态；此后 agent 或你改动文件， 这里就会出现可对比、可回滚的版本。")}
          </p>
        )}
        {items.map((s, i) => (
          <SnapshotRow key={s.id} info={s} isLatest={i === 0} />
        ))}
      </div>
    </aside>
  );
}

function SnapshotRow({ info, isLatest }: { info: SnapshotInfo; isLatest: boolean }) {
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const tickBump = () => useApp.setState((s) => ({ snapshotTick: s.snapshotTick + 1 }));

  useEffect(() => {
    if (open && changes === null) {
      backend.snapshotChanges(info.id).then(setChanges).catch(() => setChanges([]));
    }
  }, [open, changes, info.id]);

  return (
    <div className="border-b border-rule">
      <button
        className="flex w-full items-start gap-2 px-3.5 py-2.5 text-left hover:bg-[var(--hover-surface)]"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <CaretRight
          size={11}
          className={`mt-1 shrink-0 text-muted transition-transform duration-[var(--duration-base)] ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] text-ink">
            {info.label}
            {isLatest && <span className="ml-1.5 text-[12px] text-accent-cool">{t("最新")}</span>}
          </span>
          <span className="block font-sans text-[12.5px] tabular-nums text-muted">
            {formatRelTime(info.time)} · {info.filesChanged} {t("文件")}
            <span className="text-accent-cool"> +{info.insertions}</span>
            <span className="text-accent-warm"> −{info.deletions}</span>
            <span className="ml-1 opacity-60">{info.id}</span>
          </span>
        </span>
      </button>
      {open && (
        <div className="pb-2 pl-7 pr-3">
          {changes === null && <p className="py-1 text-[13px] text-muted">…</p>}
          {changes?.length === 0 && <p className="py-1 text-[13px] text-muted">{t("（空快照）")}</p>}
          {changes?.map((c) => (
            <FileRow key={c.path} change={c} snapId={info.id} />
          ))}
          <div className="mt-2 border-t border-rule pt-2">
            {!confirmRestore ? (
              <button
                className="btn !py-0.5 !text-[13px] text-muted hover:text-accent-warm"
                onClick={() => setConfirmRestore(true)}
              >
                <ArrowCounterClockwise size={12} className="mr-1 inline" aria-hidden />
                {t("还原整库到此快照…")}
              </button>
            ) : (
              <div className="rounded-[3px] border border-rule bg-card p-2 font-sans text-[13px] leading-relaxed text-muted">
                {t("文库将完全回到此快照的状态；当前状态会先自动快照，之后新增的文件也会被移除（可从安全快照找回）。")}
                <span className="mt-1.5 flex gap-2">
                  <button
                    className="btn btn-outline !py-0.5 !text-[13px] text-accent-warm"
                    onClick={() => {
                      setConfirmRestore(false);
                      void backend.restoreSnapshot(info.id).then(tickBump);
                    }}
                  >
                    {t("确认还原")}
                  </button>
                  <button className="btn !py-0.5 !text-[13px]" onClick={() => setConfirmRestore(false)}>
                    {t("取消")}
                  </button>
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FileRow({ change, snapId }: { change: FileChange; snapId: string }) {
  const openDiff = useApp((s) => s.openDiff);
  const [confirm, setConfirm] = useState(false);
  const tickBump = () => useApp.setState((s) => ({ snapshotTick: s.snapshotTick + 1 }));
  const Icon =
    change.status === "added" ? FilePlus : change.status === "deleted" ? FileX : PencilSimple;
  const color =
    change.status === "added"
      ? "text-accent-cool"
      : change.status === "deleted"
        ? "text-accent-warm"
        : "text-muted";
  return (
    <div className="group flex items-center gap-1.5 rounded-[3px] px-1 py-[3px] hover:bg-[var(--hover-surface)]">
      <Icon size={13} className={`shrink-0 ${color}`} aria-hidden />
      <button
        className="min-w-0 flex-1 truncate text-left text-[13px] text-ink"
        title={t("{0} · 点击查看此快照的改动", [change.path])}
        onClick={() =>
          openDiff({
            path: change.path,
            from: `${snapId}~1`,
            to: snapId,
            fromLabel: "上一版",
          })
        }
      >
        {change.path}
      </button>
      <button
        className="btn hidden !px-1.5 !py-0 !text-[12.5px] text-muted group-hover:inline"
        title={t("此快照中的版本 vs 当前文件")}
        onClick={() => openDiff({ path: change.path, from: snapId, fromLabel: snapId })}
      >
        {t("与当前比")}
      </button>
      {!confirm ? (
        <button
          className="btn hidden !px-1.5 !py-0 !text-[12.5px] text-muted group-hover:inline hover:text-accent-warm"
          title={t("把这个文件还原到此快照")}
          onClick={() => setConfirm(true)}
        >
          {t("还原")}
        </button>
      ) : (
        <span className="flex shrink-0 gap-1">
          <button
            className="btn btn-outline !px-1.5 !py-0 !text-[12.5px] text-accent-warm"
            onClick={() => {
              setConfirm(false);
              void backend.restoreFile(snapId, change.path).then(tickBump);
            }}
          >
            {t("确认")}
          </button>
          <button className="btn !px-1.5 !py-0 !text-[12.5px]" onClick={() => setConfirm(false)}>
            {t("取消")}
          </button>
        </span>
      )}
    </div>
  );
}
