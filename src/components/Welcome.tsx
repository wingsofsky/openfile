import { useEffect, useState } from "react";
import { BookOpen, ClockCounterClockwise } from "@phosphor-icons/react";
import { useApp } from "../state/store";
import { backend } from "../lib/backend";
import type { RecentLibrary } from "../lib/types";
import { t } from "../i18n";

export function Welcome() {
  const chooseLibrary = useApp((s) => s.chooseLibrary);
  const setLibraryPath = useApp((s) => s.setLibraryPath);
  const [path, setPath] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentLibrary[]>([]);
  const [dropOver, setDropOver] = useState(false);

  useEffect(() => {
    backend.getRecents().then(setRecents).catch(() => setRecents([]));
  }, []);

  // 拖到欢迎页 = 以 Openfile 打开（推断工作区、开文档）；路径由 Rust 暂存，这里只说「刚才那次拖放」
  useEffect(() => {
    if (!backend.transfer) return;
    return backend.transfer.onDragDrop((e) => {
      setDropOver(e.type === "over");
      if (e.type !== "drop") return;
      setErr(null);
      void backend
        .openDropped()
        .then((ok) => { if (!ok) setErr(t("拖进来的不是能打开的文件或文件夹")); })
        .catch((x) => setErr(String(x)));
    });
  }, []);

  const submitPath = async () => {
    if (!path.trim()) return;
    try {
      setErr(null);
      await setLibraryPath(path.trim());
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className={`flex h-full items-center justify-center px-6 ${dropOver ? "bg-[var(--hover-surface)]" : ""}`}>
      <div className="w-full max-w-md text-center">
        <BookOpen size={40} weight="regular" className="mx-auto text-muted" aria-hidden />
        <h1 className="mt-4 font-serif text-[26px] font-bold">Openfile</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          {t("一个文件夹，组织你与 agent 的文档协作。")}
          <br />
          {t("阅读多种格式，在审阅视图逐条接受或拒绝建议。")}
        </p>
        <div className="mt-7">
          <button className="btn btn-primary" onClick={() => void chooseLibrary()}>
            {t("选择文库文件夹")}
          </button>
        </div>
        {backend.transfer && (
          <p className="mt-3 text-[13px] text-muted">{t("支持拖入文件夹或文件")}</p>
        )}
        {recents.filter((r) => r.exists).length > 0 && (
          <div className="mt-7 border-t border-rule pt-5 text-left">
            <p className="mb-1.5 flex items-center gap-1.5 font-sans text-[12.5px] tracking-wide text-muted">
              <ClockCounterClockwise size={12} aria-hidden /> {t("最近文库")}
            </p>
            {recents
              .filter((r) => r.exists)
              .slice(0, 5)
              .map((r) => (
                <button
                  key={r.root}
                  className="flex w-full items-baseline gap-2 rounded-[3px] px-2 py-1.5 text-left hover:bg-[var(--hover-surface)]"
                  onClick={() => void setLibraryPath(r.root).catch((e) => setErr(String(e)))}
                  title={r.root}
                >
                  <span className="shrink-0 text-[14.5px] text-ink">{r.name}</span>
                  <span className="truncate font-sans text-[12.5px] text-muted">{r.root}</span>
                </button>
              ))}
          </div>
        )}
        {backend.kind === "dev" && (
          <div className="mt-6 border-t border-rule pt-5 text-left">
            <div className="flex gap-2">
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submitPath()}
                placeholder="/Users/you/your-project"
                className="min-w-0 flex-1 rounded-[3px] border border-rule bg-card px-3 py-1.5 text-[14px] text-ink placeholder:text-muted focus:outline-none"
              />
              <button className="btn btn-outline" onClick={() => void submitPath()}>
                {t("打开")}
              </button>
            </div>
          </div>
        )}
        {err && <p className="mt-3 text-[13px] text-accent-warm">{err}</p>}
      </div>
    </div>
  );
}
