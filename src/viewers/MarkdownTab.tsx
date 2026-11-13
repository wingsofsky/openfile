/**
 * md 文件的三模式壳：
 *   阅读 —— 纯净只读：标记照常渲染，但选中/点击零打扰（复制文本不弹任何东西）
 *   审阅 —— 人类创作与决策：直接打字即修订（插入/替换/删除写成 CriticMarkup）、
 *          选中弹批注条、点标记接受/拒绝
 *   编辑 —— CM6 直接改原文（语法级操作、agent 视角）；字号与底色同审阅（SourceEditor.tsx）
 */
import { useEffect, useState } from "react";
import { BookOpen, Check, ClipboardText, Code, FileArrowDown, FilePdf, Globe, PencilSimpleLine } from "@phosphor-icons/react";
import { MarkdownView, ReviewSlot } from "./MarkdownView";
import { SourceEditor } from "./SourceEditor";
import { TurnReviewHost } from "./ChangeReview";
import { t } from "../i18n";
import { useApp } from "../state/store";
import { copyReviewPrompt, exportDocxReview, reviewPrompt } from "../lib/file-actions";
import { baseName } from "../lib/util";

export function MarkdownTab({ rel, anchor }: { rel: string; anchor?: string }) {
  // Word 审阅稿：直接进审阅模式，头部给「导出 Word 修订稿」
  const docxSource = /\.docx\.review\.md$/i.test(rel) ? rel.slice(0, -".review.md".length) : null;
  // 文献笔记：PDF 转出来的 Markdown，直接进审阅模式，只能高亮、批注
  const pdfSource = /\.pdf\.md$/i.test(rel) ? rel.slice(0, -".md".length) : null;
  // HTML 审阅稿：直接进审阅模式，可改可批，头部给「打开 HTML」
  const htmlSource = /\.html?\.review\.md$/i.test(rel) ? rel.slice(0, -".review.md".length) : null;
  // 审阅常开：Word / PDF / HTML 的编辑都在审阅模式里
  const [mode, setMode] = useState<"read" | "review" | "source">(docxSource || pdfSource || htmlSource ? "review" : "read");
  const openFile = useApp((s) => s.openFile);
  // 审阅统计与「全部接受 / 全部拒绝」渲染进工具栏左侧这一格（MarkdownBody 经 ReviewSlot 用 portal 放进来）
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const root = useApp((s) => s.lib?.root);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const h = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(h);
  }, [copied]);
  const source = docxSource ?? htmlSource ?? pdfSource;
  const label = docxSource
    ? t("Word 审阅稿 · {0}", [baseName(docxSource)])
    : htmlSource
      ? t("HTML 审阅稿 · {0}", [baseName(htmlSource)])
      : pdfSource
        ? t("文献笔记 · {0}", [baseName(pdfSource)])
        : null;
  return (
    // min-h-0 必须在（作为 main 1fr 行的格子条目）：缺了它 1fr=minmax(auto,1fr)
    // 会被内容最小高度撑开，整个 app 外壳随 document 滚走
    <div className="grid h-full min-h-0 grid-rows-[auto_1fr]">
      {/* 左：文件名（限宽、可截断）+ 审阅统计；右：按钮整组。放不下时右组整组换到第二行、靠右，不叠不截 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule px-3 py-1">
        {label && (
          <span className="min-w-0 max-w-[18rem] truncate font-sans text-[12.5px] text-muted" title={source ?? undefined}>
            {label}
          </span>
        )}
        <div ref={setSlot} className="flex shrink-0 items-center empty:hidden" />
        {/* 一键复制交给 agent 的提示词（带精确路径），贴进 CC 会话 */}
        <button
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[3px] px-2 py-0.5 font-sans text-[13px] text-muted hover:bg-[var(--hover-surface)] hover:text-ink"
          title={root ? reviewPrompt(root, rel) : undefined}
          onClick={() => void copyReviewPrompt(rel).then(setCopied)}
        >
          {copied ? <Check size={12} aria-hidden /> : <ClipboardText size={12} aria-hidden />}
          {copied ? t("已复制") : t("复制提示词")}
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {docxSource && (
          <>
            <ModeBtn
              active={false}
              onClick={() => void exportDocxReview(rel)}
              icon={<FileArrowDown size={12} aria-hidden />}
              label={t("导出 Word 修订稿")}
            />
            <span className="mx-1 h-3.5 w-px shrink-0 bg-rule" aria-hidden />
          </>
        )}
        {htmlSource && (
          <>
            <ModeBtn
              active={false}
              onClick={() => openFile(htmlSource)}
              icon={<Globe size={12} aria-hidden />}
              label={t("打开 HTML")}
            />
            <span className="mx-1 h-3.5 w-px shrink-0 bg-rule" aria-hidden />
          </>
        )}
        {pdfSource && (
          <>
            <ModeBtn
              active={false}
              onClick={() => openFile(pdfSource)}
              icon={<FilePdf size={12} aria-hidden />}
              label={t("打开 PDF")}
            />
            <span className="mx-1 h-3.5 w-px shrink-0 bg-rule" aria-hidden />
          </>
        )}
        <ModeBtn
          active={mode === "read"}
          onClick={() => setMode("read")}
          icon={<BookOpen size={12} aria-hidden />}
          label={t("阅读")}
        />
        <ModeBtn
          active={mode === "review"}
          onClick={() => setMode("review")}
          icon={<PencilSimpleLine size={12} aria-hidden />}
          label={t("审阅")}
        />
        <ModeBtn
          active={mode === "source"}
          onClick={() => setMode("source")}
          icon={<Code size={12} aria-hidden />}
          label={t("编辑")}
        />
        </div>
      </div>
      <div className="min-h-0">
        <TurnReviewHost rel={rel}>
          {mode === "source" ? (
            <div className="h-full min-h-0">
              <SourceEditor rel={rel} />
            </div>
          ) : (
            <div className="h-full min-h-0 overflow-y-auto">
              <ReviewSlot.Provider value={slot}>
              <MarkdownView rel={rel} review={mode === "review"} anchor={anchor} annotateOnly={!!pdfSource} />
              </ReviewSlot.Provider>
            </div>
          )}
        </TurnReviewHost>
      </div>
    </div>
  );
}

function ModeBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[3px] px-2 py-0.5 font-sans text-[13px] ${
        active ? "bg-[var(--active-surface)] text-ink" : "text-muted hover:bg-[var(--hover-surface)]"
      }`}
      aria-pressed={active}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}
