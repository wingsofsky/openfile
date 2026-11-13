/**
 * 本轮改动的逐块审阅（md / txt 等纯文本；契约见 lib/turn-changes.ts 头注释）。
 *
 * - TurnReviewHost 包在文档视图外：本轮改过这份文档、且这一轮已结束时，顶部出一条「本轮改了 N 处 → 审改动」。
 * - 审改动 = @codemirror/merge 的 unifiedMergeView：original 是轮前快照里的这份，编辑器内容是磁盘当前。
 *   每块「保留」只确认、不写盘；「撤回」把这块换回轮前内容并立即写盘，写盘带完整基线（磁盘在此期间
 *   被别人改过就拒绝，不覆盖）。编辑器只读：这里只做保留 / 撤回，要改字回编辑模式。
 * - 原文换行风格照旧（CRLF 文件写回仍是 CRLF）。基线太大（快照差异读取上限 4MB）不做逐块，只能整轮撤回。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { acceptChunk, getChunks, rejectChunk, unifiedMergeView } from "@codemirror/merge";
import { detectEol, withEol } from "@openfile/protocol/eol";
import { backend } from "../lib/backend";
import { changedLines, chunksBetween, touchedInTurn, type TurnChanges } from "../lib/turn-changes";
import { useAgent } from "../state/agent";
import { useApp } from "../state/store";
import { t } from "../i18n";
import { editorTheme } from "./SourceEditor";

/** 快照差异读取上限（运行时 shadow.ts 的 diffPair 上限）：碰到它的基线可能被截断，不能拿来逐块写回 */
const SNAPSHOT_TEXT_CAP = 4 * 1024 * 1024;
const REVIEW_CAP = SNAPSHOT_TEXT_CAP - 1;

/** 只用现有 token（美学契约）：新增用冷色、删去用暖色，不要库自带的红绿与渐变 */
const mergeTheme = EditorView.theme({
  ".cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "color-mix(in srgb, var(--color-accent-cool) 10%, transparent) !important",
  },
  ".cm-changedText": {
    background: "none !important",
    backgroundColor: "color-mix(in srgb, var(--color-accent-cool) 24%, transparent) !important",
  },
  ".cm-deletedChunk": {
    backgroundColor: "color-mix(in srgb, var(--color-accent-warm) 9%, transparent) !important",
    color: "var(--color-muted)",
  },
  ".cm-deletedChunk .cm-deletedText": {
    background: "none !important",
    textDecoration: "line-through",
    textDecorationColor: "var(--color-accent-warm)",
  },
  // 按钮占自己一行、靠右，不再绝对定位压在正文上（只有新增、没有删去的块也一样）
  ".cm-deletedChunk .cm-chunkButtons": { position: "static", display: "flex", justifyContent: "flex-end", gap: "4px", padding: "2px 6px" },
  // 库的基础样式把块按钮写死成白字无边框：照 .btn-outline / .btn-primary 的 token 重画
  ".cm-deletedChunk .cm-chunkButtons button": {
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    padding: "1px 10px",
    margin: "0",
    borderRadius: "3px",
    border: "1px solid var(--color-ink) !important",
    cursor: "pointer",
  },
  ".cm-deletedChunk .cm-chunkButtons button[name=accept]": {
    background: "var(--color-paper) !important",
    color: "var(--color-ink) !important",
  },
  ".cm-deletedChunk .cm-chunkButtons button[name=reject]": {
    background: "var(--color-ink) !important",
    color: "var(--color-paper) !important",
  },
  ".cm-collapsedLines": {
    background: "var(--color-panel) !important",
    color: "var(--color-muted) !important",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
  },
  ".cm-changeGutter": { width: "3px", paddingLeft: "1px" },
  ".cm-changedLineGutter": { background: "var(--color-accent-cool) !important" },
  ".cm-deletedLineGutter": { background: "var(--color-accent-warm) !important" },
});

/** 已逐块处理完的「轮后快照 + 文档」：保留下来的改动不再提示（同一轮内有效，下一轮重新算） */
const reviewed = new Set<string>();

/**
 * 阅读视图用：当前文档里本轮改过的行（1 起）；本轮没改过、正在跑、或已逐块处理完时为 null。
 * 视图拿它给覆盖这些行的段落加 md-turn-changed，只标出、不放按钮。
 */
export function useTurnChangedLines(rel: string): Set<number> | null {
  const tc = useAgent((s) => s.turnChanges);
  const running = useAgent((s) => s.status === "running");
  const root = useApp((s) => s.lib?.root);
  const changed = useApp((s) => s.changed);
  const touched = touchedInTurn(tc, root, rel);
  const [lines, setLines] = useState<Set<number> | null>(null);
  const stamp = changed?.paths.includes(rel) ? changed : null;
  useEffect(() => {
    setLines(null);
    if (!tc || !touched || touched.status === "deleted") return;
    let dead = false;
    backend
      .diffSnapshotFile(rel, tc.baseId)
      .then((p) => {
        if (!dead && !p.oldBinary && !p.newBinary) setLines(changedLines(p.old, p.new));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [tc, touched, rel, stamp]);
  if (!tc || running || reviewed.has(`${tc.headId}:${rel}`) || !lines?.size) return null;
  return lines;
}

/** 文档视图的外壳：有本轮改动时顶部出提示条，点开进逐块审阅 */
export function TurnReviewHost({ rel, children }: { rel: string; children: ReactNode }) {
  const tc = useAgent((s) => s.turnChanges);
  const running = useAgent((s) => s.status === "running");
  const root = useApp((s) => s.lib?.root);
  const changed = useApp((s) => s.changed);
  const touched = touchedInTurn(tc, root, rel);
  const [count, setCount] = useState(0);
  const [reviewing, setReviewing] = useState(false);

  // 数一数本轮在这份文档里改了几处（与审阅视图同一切法）；文件再变就重数
  const stamp = changed?.paths.includes(rel) ? changed : null;
  useEffect(() => {
    setCount(0);
    if (!tc || !touched || touched.status === "deleted") return;
    let dead = false;
    backend
      .diffSnapshotFile(rel, tc.baseId)
      .then((p) => {
        if (!dead && !p.oldBinary && !p.newBinary) setCount(chunksBetween(p.old, p.new).length);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [tc, touched, rel, stamp]);

  useEffect(() => setReviewing(false), [rel, tc]);

  const key = tc ? `${tc.headId}:${rel}` : "";
  const close = (allHandled: boolean) => {
    if (allHandled) reviewed.add(key);
    setReviewing(false);
  };
  if (reviewing && tc && touched) return <ChangeReview rel={rel} tc={tc} onClose={close} />;
  if (!touched || count === 0 || running || reviewed.has(key)) return <>{children}</>;
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_1fr]">
      <div className="flex items-center gap-2 border-b border-rule bg-card px-3 py-1.5 font-sans text-[13px] text-ink">
        <span className="flex-1">{t("第 {0} 轮在这份文档里改了 {1} 处", [tc!.turn, count])}</span>
        <button className="btn btn-primary !py-0.5 !text-[13px]" onClick={() => setReviewing(true)}>
          {t("审改动")}
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}

function ChangeReview({ rel, tc, onClose }: { rel: string; tc: TurnChanges; onClose: (allHandled: boolean) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const root = useApp((s) => s.lib?.root);
  const [left, setLeft] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let dead = false;
    setNote(null);
    setError(null);
    setLeft(null);
    Promise.all([backend.diffSnapshotFile(rel, tc.baseId), backend.readText(rel, REVIEW_CAP)])
      .then(([pair, cur]) => {
        if (dead || !hostRef.current) return;
        if (pair.oldBinary || cur.encoding === "binary") return setNote(t("二进制文件不能逐块审阅，可在会话面板整轮撤回。"));
        if (cur.encoding !== "utf-8") return setNote(t("这份文件不是 UTF-8，逐块撤回会改变编码；可在会话面板整轮撤回。"));
        if (cur.truncated || new TextEncoder().encode(pair.old).length >= REVIEW_CAP) {
          return setNote(t("文件太大（超过 4MB），不能逐块审阅；可在会话面板整轮撤回。"));
        }
        const eol = detectEol(cur.content);
        // 最近一次写盘（或读到）的磁盘全文：撤回写盘的基线
        let onDisk = cur.content;
        // 串行写：「全部撤回」一口气改很多块，每次都写当时的最新全文、以上一次写成的为基线
        let chain = Promise.resolve();
        const persist = (view: EditorView) => {
          chain = chain
            .then(async () => {
              const content = withEol(view.state.doc.toString(), eol);
              if (content === onDisk) return;
              await backend.writeText(rel, content, root, onDisk);
              onDisk = content;
            })
            .catch((e) => {
              if (!dead) setError(e instanceof Error ? e.message : String(e));
            });
        };
        const button = (type: "accept" | "reject", action: (e: MouseEvent) => void) => {
          const b = document.createElement("button");
          b.name = type;
          b.textContent = type === "accept" ? t("保留") : t("撤回");
          b.onmousedown = action;
          return b;
        };
        const state = EditorState.create({
          doc: cur.content,
          extensions: [
            EditorView.lineWrapping,
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            editorTheme,
            mergeTheme,
            // 库里折叠条的英文短语（「13 unchanged lines」）走界面语言
            EditorState.phrases.of({ "$ unchanged lines": t("展开 $ 行未改动的内容") }),
            unifiedMergeView({ original: pair.old, mergeControls: button, collapseUnchanged: { margin: 3, minSize: 6 }, gutter: true }),
            EditorView.updateListener.of((u) => {
              const n = getChunks(u.state)?.chunks.length ?? 0;
              setLeft(n);
              if (u.docChanged) persist(u.view);
            }),
          ],
        });
        viewRef.current = new EditorView({ state, parent: hostRef.current });
        setLeft(getChunks(state)?.chunks.length ?? 0);
      })
      .catch((e) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      dead = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [rel, tc, root, reload]);

  const all = (fn: typeof acceptChunk) => {
    const view = viewRef.current;
    if (!view) return;
    // 从后往前：前面的块位置不受后面撤回的影响
    const chunks = [...(getChunks(view.state)?.chunks ?? [])].reverse();
    for (const c of chunks) fn(view, c.fromB);
  };

  const done = left === 0;
  const status = useMemo(
    () => (done ? t("这份文档里本轮的改动都处理完了。") : left === null ? "" : t("{0} 处改动待审阅", [left])),
    [done, left],
  );

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_auto_1fr]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-rule bg-panel px-3 py-1.5 font-sans text-[13px]">
        <span className="flex-1 text-ink">{status}</span>
        {!done && !note && (
          <>
            <button className="btn btn-outline !py-0.5 !text-[13px]" onClick={() => all(acceptChunk)}>
              {t("全部保留")}
            </button>
            <button className="btn btn-outline !py-0.5 !text-[13px]" onClick={() => all(rejectChunk)}>
              {t("全部撤回")}
            </button>
          </>
        )}
        <button className="btn btn-primary !py-0.5 !text-[13px]" onClick={() => onClose(left === 0)}>
          {t("完成")}
        </button>
      </div>
      {error || note ? (
        <div className="flex items-center gap-2 border-b border-rule bg-card px-3 py-1.5 font-sans text-[13px] text-accent-warm">
          <span className="flex-1">{error ? t("撤回没写进去：{0}", [error]) : note}</span>
          {error && (
            <button className="btn btn-outline !py-0.5 !text-[13px]" onClick={() => setReload((n) => n + 1)}>
              {t("按磁盘现状重新载入")}
            </button>
          )}
        </div>
      ) : (
        <div />
      )}
      <div ref={hostRef} className="min-h-0 overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto" />
    </div>
  );
}
