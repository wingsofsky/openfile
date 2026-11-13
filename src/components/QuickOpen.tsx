import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { backend } from "../lib/backend";
import type { SearchHit } from "../lib/types";
import { baseName, parentOf } from "../lib/util";
import { useApp } from "../state/store";
import { t } from "../i18n";

export function QuickOpen() {
  const visible = useApp((s) => s.quickOpenVisible);
  const setVisible = useApp((s) => s.setQuickOpen);
  const openFile = useApp((s) => s.openFile);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (visible) {
      setQ("");
      setHits([]);
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const seq = ++seqRef.current;
    const t = setTimeout(() => {
      if (!q.trim()) {
        setHits([]);
        return;
      }
      backend
        .searchFiles(q, 50)
        .then((h) => {
          if (seqRef.current === seq) {
            setHits(h);
            setSel(0);
          }
        })
        .catch(() => {});
    }, 90);
    return () => clearTimeout(t);
  }, [q, visible]);

  if (!visible) return null;

  const choose = (rel: string) => {
    openFile(rel);
    setVisible(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-[var(--overlay)]"
      onClick={() => setVisible(false)}
      role="presentation"
    >
      <div
        className="mx-auto mt-[12vh] w-[min(600px,90vw)] overflow-hidden rounded-[4px] border border-rule bg-card shadow-[var(--shadow-card)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("快速打开文件")}
      >
        <div className="flex items-center gap-2 border-b border-rule px-3.5 py-2.5">
          <MagnifyingGlass size={15} className="shrink-0 text-muted" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setVisible(false);
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, hits.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              }
              if (e.key === "Enter" && hits[sel]) choose(hits[sel].rel);
            }}
            placeholder={t("按文件名搜索…")}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-muted focus:outline-none"
            aria-label={t("按文件名搜索")}
          />
          <kbd className="shrink-0 rounded-[2px] border border-rule px-1 text-[12px] text-muted">esc</kbd>
        </div>
        {hits.length > 0 && (
          <ul className="max-h-[46vh] overflow-y-auto py-1" role="listbox">
            {hits.map((h, i) => (
              <li key={h.rel} role="option" aria-selected={i === sel}>
                <button
                  className={`flex w-full items-baseline gap-2 px-3.5 py-1.5 text-left ${
                    i === sel ? "bg-[var(--active-surface)]" : "hover:bg-[var(--hover-surface)]"
                  }`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => choose(h.rel)}
                >
                  <span className="shrink-0 text-[14.5px] text-ink">{baseName(h.rel)}</span>
                  <span className="truncate text-[13px] text-muted">{parentOf(h.rel)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {q.trim() && hits.length === 0 && (
          <p className="px-3.5 py-3 text-[13.5px] text-muted">{t("没有匹配的文件")}</p>
        )}
      </div>
    </div>
  );
}
