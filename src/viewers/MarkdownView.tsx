import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import { backend } from "../lib/backend";
import { readBom } from "../lib/complete-text";
import { analyze, type TocItem } from "../lib/markdown";
import { countCritic, type CriticSegment } from "@openfile/protocol/criticmarkup";
import { resolveAll, resolveMark } from "../lib/keep-emphasis";
import { planAnnotation, type AnnotateAction } from "../lib/annotate";
import { analyzeReview } from "../lib/review-transform";
import { chunkPipeline } from "../lib/markdown-pipeline";
import { breakText, opStart, outOfFormat, pasteText, planEdit, type EditOp } from "../lib/suggest-edit";
import { breakSpot, canJoinBlock, domPointToSource, edgePiece, leaveDeletedEdge, placeCaret, rangePieces, type Piece } from "../lib/source-offsets";
import { isExternalUrl, resolveRel } from "../lib/util";
import { useApp } from "../state/store";
import { openExternal } from "../lib/external";
import { t } from "../i18n";
import { useTurnChangedLines } from "./ChangeReview";

const REL_LINK_PREFIX = "openfile-rel:";
const BLOCKED_IMG = "openfile-blocked:";
const DEFAULT_CAP = 4 * 1024 * 1024;
const FULL_CAP = 64 * 1024 * 1024;

interface Props {
  rel: string;
  /** 审阅模式：开 = 打字即修订 + 选中弹批注条 + 标记可接受/拒绝；关 = 纯净阅读 */
  review?: boolean;
  /** 打开即跳到的标题锚 id */
  anchor?: string;
  /** 只标注（文献笔记）：审阅模式下只能高亮、批注，正文不能打字修订 */
  annotateOnly?: boolean;
}

export function MarkdownView({ rel, review = false, anchor, annotateOnly = false }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedTick, setUpdatedTick] = useState(0);
  const [cap, setCap] = useState(DEFAULT_CAP);
  const [saveError, setSaveError] = useState<string | null>(null);
  const changed = useApp((s) => s.changed);
  const turnLines = useTurnChangedLines(rel);

  /** 打字即修订一键一提交：合并成停顿后再写盘；有待写内容时不让磁盘回读盖掉刚打的字 */
  const pendingRef = useRef<{ text: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** 读取时剥掉的 BOM，审阅写盘时补回（格式主权：不改用户文件的字节头） */
  const bomRef = useRef("");

  const srcNow = useRef<string | null>(null);
  srcNow.current = src;

  /** flash：内容真变了才提示「磁盘上更新了」（自己刚写的、刚建好的文件回读时内容相同，不提示） */
  const load = useCallback(
    (max: number, flash = false) => {
      backend
        .readText(rel, max)
        .then((r) => {
          if (pendingRef.current) return;
          if (flash && srcNow.current !== null && srcNow.current !== r.content) setUpdatedTick(Date.now());
          bomRef.current = readBom(r);
          setSrc(r.content);
          setTruncated(r.truncated);
          setError(null);
        })
        .catch((e) => setError(String(e)));
    },
    [rel],
  );

  useEffect(() => {
    setSrc(null);
    setError(null);
    setCap(DEFAULT_CAP);
    load(DEFAULT_CAP);
  }, [rel, load]);

  const flush = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
    backend.writeText(rel, bomRef.current + p.text).catch((e) => setSaveError(String(e)));
  }, [rel]);
  useEffect(() => flush, [flush]);

  useEffect(() => {
    if (changed?.paths.includes(rel)) {
      if (pendingRef.current) return;
      load(cap, true);
    }
  }, [changed, rel, load, cap]);

  /** 审阅落盘：截断态禁用（防止用部分内容覆盖全文） */
  const commitSource = useCallback(
    (next: string) => {
      if (truncated) {
        setSaveError(t("文件是截断加载的，先「载入全文」再做审阅操作"));
        return;
      }
      setSrc(next); // 乐观更新；watcher 回读为准
      setSaveError(null);
      if (pendingRef.current) clearTimeout(pendingRef.current.timer);
      pendingRef.current = { text: next, timer: setTimeout(flush, 400) };
    },
    [truncated, flush],
  );

  if (error) return <ErrorNote text={error} />;
  if (src === null) return null;

  return (
    <div className="px-8 py-10">
      {/* 有本轮改动条时它已说明文件变了，不再叠一条刷新提示 */}
      {updatedTick > 0 && !turnLines && <UpdatedFlash key={updatedTick} />}
      {saveError && (
        <p className="prose-reader mb-4 font-sans text-[13.5px] text-accent-warm">{saveError}</p>
      )}
      {truncated && (
        <div className="prose-reader mb-6">
          <div className="flex items-center justify-between gap-3 rounded-[3px] border border-rule bg-panel px-4 py-2 font-sans text-[13.5px] text-muted">
            <span>{t("文件较大，已先载入前一部分。")}</span>
            <button
              className="btn btn-outline shrink-0 !text-[13px]"
              onClick={() => {
                setCap(FULL_CAP);
                load(FULL_CAP);
              }}
            >
              {t("载入全文")}
            </button>
          </div>
        </div>
      )}
      {/* 审阅交互（选区批注/接受拒绝）只在审阅模式启用——阅读模式零打扰 */}
      <MarkdownBody
        src={src}
        rel={rel}
        anchor={anchor}
        onCommitSource={review ? commitSource : undefined}
        annotateOnly={annotateOnly}
        changedLines={turnLines}
      />
    </div>
  );
}

/** 叶子块：列表项里有段落时标段落，不重复标整个 li */
const TURN_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "tr", "li"]);

/**
 * rehype 插件：给覆盖本轮改动行的叶子块加 md-turn-changed。节点行号相对本块，加 chunkStart 换成整份源文的行号
 * （与标题目录同一口径）。放在 sanitize 之后，类名不会被白名单剥掉。
 */
function rehypeTurnLines(lines: Set<number> | null | undefined, chunkStart: number) {
  type El = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: El[]; position?: { start: { line: number }; end: { line: number } } };
  const hit = (n: El) => {
    if (!n.position) return false;
    for (let l = n.position.start.line; l <= n.position.end.line; l++) if (lines!.has(chunkStart + l - 1)) return true;
    return false;
  };
  const walk = (n: El) => {
    if (n.type === "element" && n.tagName && TURN_BLOCKS.has(n.tagName)) {
      const leaf = n.tagName !== "li" || !n.children?.some((c) => c.type === "element" && c.tagName === "p");
      if (leaf && hit(n)) {
        const cls = n.properties?.className;
        n.properties = { ...n.properties, className: [...(Array.isArray(cls) ? cls : cls ? [String(cls)] : []), "md-turn-changed"] };
      }
    }
    n.children?.forEach(walk);
  };
  return (tree: El) => {
    if (lines?.size) walk(tree);
  };
}

function UpdatedFlash() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setOn(false), 2000);
    return () => clearTimeout(t);
  }, []);
  if (!on) return null;
  return (
    <p className="prose-reader mb-4 font-sans text-[13px] text-accent-cool">
      {t("文件已在磁盘上更新，内容已刷新。")}
    </p>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <div className="px-8 py-10">
      <p className="prose-reader font-sans text-[14px] text-accent-warm">{text}</p>
    </div>
  );
}

/** 远程图片默认不加载；点击后才真正拉取（用户显式同意联网） */
function RemoteImage({ url, alt }: { url: string; alt?: string }) {
  const [load, setLoad] = useState(false);
  if (load) return <img src={url} alt={alt} />;
  return (
    <button
      type="button"
      onClick={() => setLoad(true)}
      className="my-2 inline-flex items-center gap-2 rounded-[3px] border border-dashed border-rule px-3 py-2 font-sans text-[13px] text-muted hover:text-ink"
      title={url}
    >
      {t("🖼 点击加载远程图片")}{alt ? t("：{0}", [alt]) : ""}
    </button>
  );
}

interface PopState {
  cmid: number;
  top: number;
  left: number;
}

interface SelBarState {
  top: number;
  left: number;
  chunkIdx: number;
  /** 选区起点的源码偏移（能映射时）：同一句话出现多次也定位得准 */
  at?: number;
  /** 阅读视图选中的纯文本 */
  text: string;
  /** 选中即入批注输入态；「替换」一键切换，没有按钮中转态 */
  mode: "comment" | "sub";
  input: string;
  err: string | null;
}

/** 文档工具栏左侧的一格：审阅统计与「全部接受 / 全部拒绝」放进去，不占正文（MarkdownTab 提供） */
export const ReviewSlot = createContext<HTMLElement | null>(null);

export const MarkdownBody = memo(function MarkdownBody({
  src,
  rel,
  anchor,
  onCommitSource,
  annotateOnly = false,
  changedLines,
}: {
  src: string;
  rel: string;
  /** 打开即跳到的标题锚 id（tab.anchor） */
  anchor?: string;
  /** 提供时启用审阅交互（接受/拒绝并落盘） */
  onCommitSource?: (next: string) => void;
  /** 只标注：不开打字即修订，选区条只给高亮与批注 */
  annotateOnly?: boolean;
  /** 会话本轮改过的源码行（1 起）：覆盖它们的段落加 md-turn-changed */
  changedLines?: Set<number> | null;
}) {
  const openFile = useApp((s) => s.openFile);
  const { toc, chunks } = useMemo(() => analyze(src), [src]);
  const segments = useMemo(() => analyzeReview(src), [src]);
  const counts = useMemo(() => countCritic(src), [src]);
  const [pop, setPop] = useState<PopState | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  /* ---- 选区批注（选中文字 → 批注/划线/替换） ---- */
  const [author, setAuthor] = useState("我");
  useEffect(() => {
    backend.getUserName().then(setAuthor).catch(() => {});
  }, []);
  const [selBar, setSelBar] = useState<SelBarState | null>(null);
  /** 批注条开着时被选中的那段：焦点进了输入框以后，靠 CSS 高亮把它画出来（theme.css 的 review-selection） */
  const selRangeRef = useRef<Range | null>(null);
  const selOpen = selBar !== null;
  useEffect(() => {
    const registry = globalThis.CSS?.highlights;
    if (!registry || typeof Highlight === "undefined") return;
    if (!selOpen || !selRangeRef.current) {
      registry.delete("review-selection");
      return;
    }
    registry.set("review-selection", new Highlight(selRangeRef.current));
    return () => {
      registry.delete("review-selection");
    };
  }, [selOpen]);

  const onTextSelect = useCallback(() => {
    if (!onCommitSource) return;
    // 等浏览器结算选区后再读（mouseup 时 Selection 可能还是旧值）。
    // 用宏任务而非 rAF：隐藏/被遮挡的 webview 里 rAF 会被冻结（已知坑）
    setTimeout(() => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) {
        setSelBar(null); // 点到别处（条内交互不冒泡到这里）
        return;
      }
      const range = s.getRangeAt(0);
      // Range.toString() 是 DOM 级取文，比 Selection.toString()（布局级，
      // 隐藏 webview 下返回空）更稳
      const text = range.toString();
      if (!text.trim()) return;
      const secOf = (n: Node | null) => {
        const el = n instanceof Element ? n : n?.parentElement;
        return el?.closest?.("section[data-chunk]") ?? null;
      };
      const a = secOf(range.startContainer);
      const b = secOf(range.endContainer);
      if (!a || a !== b) return; // 跨块选区（罕见）：不弹条
      const body = bodyRef.current;
      if (!body) return;
      selRangeRef.current = range.cloneRange();
      const r = range.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      setSelBar({
        top: r.bottom - br.top + 6,
        left: Math.max(0, r.left - br.left),
        chunkIdx: Number(a.getAttribute("data-chunk")),
        at: domPointToSource(range.startContainer, range.startOffset) ?? undefined,
        text,
        mode: "comment", // 选中即可直接打批注，零多余点击
        input: "",
        err: null,
      });
    });
  }, [onCommitSource]);

  const tocByLine = useMemo(() => {
    const m = new Map<number, TocItem>();
    toc.forEach((t) => m.set(t.line, t));
    return m;
  }, [toc]);

  /** 各 chunk 在全文的字符偏移（chunks 以 '\n' 连接还原全文） */
  const chunkOffsets = useMemo(() => {
    const offs: number[] = [];
    let acc = 0;
    for (const c of chunks) {
      offs.push(acc);
      acc += c.src.length + 1;
    }
    return offs;
  }, [chunks]);

  const commitAnnotate = useCallback(
    (action: AnnotateAction, payload?: string) => {
      if (!selBar || !onCommitSource) return;
      const plan = planAnnotation({
        full: src,
        chunkSrc: chunks[selBar.chunkIdx]?.src ?? "",
        chunkOffset: chunkOffsets[selBar.chunkIdx] ?? 0,
        selected: selBar.text,
        action,
        payload,
        author,
        at: selBar.at,
      });
      if (!plan.ok) {
        setSelBar({ ...selBar, err: plan.error });
        return;
      }
      onCommitSource(plan.next);
      setSelBar(null);
      window.getSelection()?.removeAllRanges();
    },
    [selBar, onCommitSource, src, chunks, chunkOffsets, author],
  );

  /* ---- 打字即修订：正文可编辑，每次输入都翻译成源码上的 CriticMarkup ---- */
  const articleRef = useRef<HTMLElement>(null);
  const srcRef = useRef(src);
  srcRef.current = src;
  const authorRef = useRef(author);
  authorRef.current = author;
  const commitRef = useRef(onCommitSource);
  commitRef.current = onCommitSource;
  /** 提交后要放回的光标（源码偏移），在下一次布局后落位 */
  const caretRef = useRef<number | null>(null);
  /** 撤销 / 重做只管本视图打字产生的版本；源码被外部改过就清空 */
  const undoRef = useRef<Array<{ src: string; caret: number }>>([]);
  const redoRef = useRef<Array<{ src: string; caret: number }>>([]);
  const lastOwnRef = useRef<string | null>(null);
  /** 输入法组合期间浏览器会直接改 DOM：结束后重挂这些块，丢掉它的改动 */
  const [epochs, setEpochs] = useState<Record<number, number>>({});
  const [hint, setHint] = useState<{ text: string; top: number; left: number } | null>(null);

  useEffect(() => {
    if (!hint) return;
    const h = setTimeout(() => setHint(null), 2600);
    return () => clearTimeout(h);
  }, [hint]);

  useLayoutEffect(() => {
    const c = caretRef.current;
    const art = articleRef.current;
    if (c === null || !art) return;
    caretRef.current = null;
    placeCaret(art, c, srcRef.current);
  });

  const showHint = useCallback((text: string) => {
    const body = bodyRef.current;
    const sel = window.getSelection();
    if (!body) return;
    const br = body.getBoundingClientRect();
    const rr = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    const top = rr && (rr.top || rr.bottom) ? rr.bottom - br.top + 6 : 8;
    const left = rr && rr.left ? Math.max(0, rr.left - br.left) : 0;
    setHint({ text, top, left });
  }, []);

  const applyEdit = useCallback(
    (op: EditOp, remount?: number[]) => {
      const commit = commitRef.current;
      if (!commit) return;
      const cur = srcRef.current;
      if (lastOwnRef.current !== cur) {
        undoRef.current = [];
        redoRef.current = [];
      }
      if (remount?.length) {
        setEpochs((m) => {
          const n = { ...m };
          for (const i of remount) n[i] = (n[i] ?? 0) + 1;
          return n;
        });
      }
      const plan = planEdit(cur, op, authorRef.current);
      if (!plan.ok) {
        if (remount) caretRef.current = opStart(op);
        showHint(plan.error);
        return;
      }
      undoRef.current.push({ src: cur, caret: op.kind === "pieces" || op.kind === "join" || (op.kind === "delete" && op.at === op.end && op.dir === "forward") ? opStart(op) : op.end });
      if (undoRef.current.length > 200) undoRef.current.shift();
      redoRef.current = [];
      lastOwnRef.current = plan.next;
      caretRef.current = plan.caret;
      setSelBar(null);
      setPop(null);
      commit(plan.next);
    },
    [showHint],
  );

  const history = useCallback((dir: "undo" | "redo") => {
    const commit = commitRef.current;
    const cur = srcRef.current;
    if (!commit || lastOwnRef.current !== cur) return;
    const [from, to] = dir === "undo" ? [undoRef.current, redoRef.current] : [redoRef.current, undoRef.current];
    const step = from.pop();
    if (!step) return;
    const sel = window.getSelection();
    const here = sel?.rangeCount ? domPointToSource(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset) : null;
    to.push({ src: cur, caret: here ?? step.caret });
    lastOwnRef.current = step.src;
    caretRef.current = step.caret;
    commit(step.src);
  }, []);

  // 用 layout effect：正文在提交时就可编辑，晚一拍挂监听，这期间的输入会被浏览器直接改进 DOM，不落盘
  useLayoutEffect(() => {
    const art = articleRef.current;
    if (!art || !onCommitSource) return;

    const chunkOf = (n: Node) => {
      const el = n instanceof Element ? n : n.parentElement;
      const sec = el?.closest("section[data-chunk]");
      return sec ? Number(sec.getAttribute("data-chunk")) : -1;
    };
    /** 一个 DOM 区间 → 源码区间（两端都得落在可编辑文字上） */
    const toSource = (r: { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number; collapsed: boolean }) => {
      const a = domPointToSource(r.startContainer, r.startOffset);
      const b = r.collapsed ? a : domPointToSource(r.endContainer, r.endOffset);
      if (a === null || b === null) return null;
      return [Math.min(a, b), Math.max(a, b)] as const;
    };
    const liveOf = (r: StaticRange | Range) => {
      const live = document.createRange();
      live.setStart(r.startContainer, r.startOffset);
      live.setEnd(r.endContainer, r.endOffset);
      return live;
    };
    /** 选区盖住的字在源码里的各段；有对不上源码的内容（代码、公式、图片）就提示 */
    const piecesOf = (r: StaticRange | Range): Piece[] | null => {
      const pieces = rangePieces(liveOf(r));
      if (!pieces) showHint(t("选区里有代码、公式或图片，不能整体修订——缩小选区，或切到编辑模式处理"));
      return pieces;
    };

    let composing: { a: number; pieces: Piece[] | null; chunk: number } | null = null;
    /**
     * 输入法组合期间浏览器会直接改 DOM（拦不住）。记下每一处改动，结束后倒序精确还原，再按源码正常渲染修订。
     * 不卸载重挂：React 管的节点一个不换，选区不会悬空——WebKit 遇到选区所在节点被摘掉，会把光标甩到段尾。
     */
    let observer: MutationObserver | null = null;
    let records: MutationRecord[] = [];
    const watchComposition = () => {
      observer?.disconnect();
      records = [];
      observer = new MutationObserver((list) => records.push(...list));
      observer.observe(art, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
    };
    /** 倒序撤回记下的改动；对不上（极少见）返回 false，由调用方整块重挂兜底 */
    const revertComposition = (): boolean => {
      const list = [...records, ...(observer?.takeRecords() ?? [])];
      observer?.disconnect();
      observer = null;
      records = [];
      try {
        for (let i = list.length - 1; i >= 0; i--) {
          const m = list[i];
          if (m.type === "characterData") {
            (m.target as CharacterData).data = m.oldValue ?? "";
            continue;
          }
          for (const n of m.addedNodes) if (n.parentNode === m.target) m.target.removeChild(n);
          const before = m.nextSibling && m.nextSibling.parentNode === m.target ? m.nextSibling : null;
          for (const n of m.removedNodes) m.target.insertBefore(n, before);
        }
        return true;
      } catch {
        return false;
      }
    };

    const onBeforeInput = (e: InputEvent) => {
      const type = e.inputType;
      if (type === "insertCompositionText" || type === "deleteCompositionText" || type === "insertFromComposition" || type === "deleteByComposition") {
        return; // 组合输入交给浏览器，compositionend 再统一落盘
      }
      e.preventDefault();
      if (type === "historyUndo") return history("undo");
      if (type === "historyRedo") return history("redo");
      if (type.startsWith("format")) return;
      if (type === "insertFromDrop") return showHint(t("审阅模式不支持拖放——用复制粘贴"));

      const sel = window.getSelection();
      const target = e.getTargetRanges?.()[0];
      const live = sel?.rangeCount ? sel.getRangeAt(0) : null;
      const range = type.startsWith("delete") && target && !(type === "deleteContentBackward" || type === "deleteContentForward") ? target : live;
      if (!range) return;

      if (type === "insertParagraph" || type === "insertLineBreak") {
        const soft = type === "insertLineBreak";
        const spot = breakSpot(range.startContainer, range.startOffset, soft);
        if (spot === "table") return showHint(t("表格单元格里不能换行——切到编辑模式处理"));
        if (spot === "format") return showHint(t("加粗、链接中间不能分段——把光标移到它的前后，或用 Shift+Enter 换行"));
        if (!spot) return showHint(t("这里不能直接修订（公式、图片等）——切到编辑模式处理"));
        const cur = srcRef.current;
        const at = spot.edge ? outOfFormat(cur, spot.at, spot.edge) : spot.at;
        const text = breakText(cur, at, soft, spot.inList);
        if (range.collapsed) return applyEdit({ kind: "insert", at, end: at, text });
        const pieces = piecesOf(range);
        if (pieces) applyEdit({ kind: "pieces", pieces, text, dir: "back" });
        return;
      }

      if (type.startsWith("insert")) {
        const text = type === "insertReplacementText" || type === "insertFromPaste" || type === "insertFromYank"
          ? (e.dataTransfer?.getData("text/plain") ?? e.data ?? "")
          : (e.data ?? "");
        let flat = text.replace(/\r?\n$/, "");
        if (!flat) return;
        // 替换选中的字（拼写建议给的是它自己的区间）：按页面上的字拆段，格式符号留着
        const over = type === "insertReplacementText" && target ? target : range.collapsed ? null : range;
        const src = over ? null : toSource(range);
        if (/\n/.test(flat)) {
          const spot = breakSpot(range.startContainer, range.startOffset, true);
          if (spot === "table") return showHint(t("表格单元格里不能换行——切到编辑模式处理"));
          if (spot && spot !== "format") flat = pasteText(srcRef.current, spot.at, flat, spot.inList);
        }
        if (over) {
          const pieces = piecesOf(over);
          if (pieces) applyEdit({ kind: "pieces", pieces, text: flat, dir: "back" });
          return;
        }
        if (!src) return showHint(t("这里不能直接修订（公式、图片等）——切到编辑模式处理"));
        applyEdit({ kind: "insert", at: src[0], end: src[0], text: flat });
        return;
      }
      if (type.startsWith("delete")) {
        const dir = type.includes("Forward") ? "forward" : "back";
        if (!range.collapsed) {
          const pieces = piecesOf(range);
          if (pieces) applyEdit({ kind: "pieces", pieces, text: "", dir });
          return;
        }
        // 退格 / 向前删：删的是页面上紧挨光标、看得见的那个字（跨过格式符号，转义出来的字整个记号算一个）
        const edge = edgePiece(range.startContainer, range.startOffset, dir);
        if (edge === "line" || edge === "block") {
          if (edge === "block" && !canJoinBlock(range.startContainer, dir)) return showHint(t("这里不能合并（表格、代码块、分隔线）——切到编辑模式处理"));
          const src = toSource(range);
          if (!src) return showHint(t("这里不能直接修订（公式、图片等）——切到编辑模式处理"));
          return applyEdit({ kind: "join", at: src[0], dir });
        }
        if (!edge) return showHint(t("这里不能直接修订（公式、图片等）——切到编辑模式处理"));
        applyEdit({ kind: "pieces", pieces: [edge], text: "", dir });
      }
    };

    const onCompStart = () => {
      const sel = window.getSelection();
      const r = sel?.rangeCount ? sel.getRangeAt(0) : null;
      // 选中一段再用输入法打字：替换那几段（格式符号留着）
      if (r && !r.collapsed) {
        const pieces = rangePieces(liveOf(r));
        composing = pieces?.length ? { a: Math.min(...pieces.map((p) => p.a)), pieces, chunk: chunkOf(r.startContainer) } : null;
      } else {
        const src = r ? toSource(r) : null;
        composing = src && r ? { a: src[0], pieces: null, chunk: chunkOf(r.startContainer) } : null;
      }
      watchComposition();
    };
    const onCompEnd = (e: CompositionEvent) => {
      const c = composing;
      composing = null;
      const data = e.data;
      // 等浏览器把这次组合的 DOM 改动做完，再撤回它、按源码重画
      setTimeout(() => {
        const clean = revertComposition();
        // 还原失败才整块重挂（会丢光标所在节点，所以只当兜底）
        const remount = clean ? [] : c ? [c.chunk] : [...art.querySelectorAll("section[data-chunk]")].map((s) => Number(s.getAttribute("data-chunk")));
        const bump = () =>
          remount.length &&
          setEpochs((m) => {
            const n = { ...m };
            for (const i of remount) n[i] = (n[i] ?? 0) + 1;
            return n;
          });
        if (!c) {
          bump();
          return showHint(t("这里不能直接修订（公式、图片等）——切到编辑模式处理"));
        }
        if (!data) {
          bump();
          if (remount.length) caretRef.current = c.a;
          else placeCaret(art, c.a, srcRef.current);
          return;
        }
        if (c.pieces) applyEdit({ kind: "pieces", pieces: c.pieces, text: data, dir: "back" }, remount);
        else applyEdit({ kind: "insert", at: c.a, end: c.a, text: data }, remount);
      });
    };

    /**
     * 光标一停在已删除文字的边上就挪到旁边的正文，而不是等按键时再挪：
     * 输入法的第一个键按下时组合已经开始，这时再动选区会打断组合，第一个字母被当英文上屏。
     * 组合期间（observer 在记录）不动选区。
     */
    const onSelectionChange = () => {
      if (observer) return;
      const sel = window.getSelection();
      if (sel?.anchorNode && art.contains(sel.anchorNode)) leaveDeletedEdge();
    };

    // 浏览器自己的撤销栈是空的（输入都被拦了），它不会发 historyUndo：快捷键自己接
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z" || (k === "y" && !e.shiftKey)) {
        e.preventDefault();
        history(k === "y" || e.shiftKey ? "redo" : "undo");
      }
    };

    art.addEventListener("keydown", onKeyDown);
    art.addEventListener("beforeinput", onBeforeInput);
    art.addEventListener("compositionstart", onCompStart);
    art.addEventListener("compositionend", onCompEnd);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      art.removeEventListener("keydown", onKeyDown);
      art.removeEventListener("beforeinput", onBeforeInput);
      art.removeEventListener("compositionstart", onCompStart);
      art.removeEventListener("compositionend", onCompEnd);
      observer?.disconnect();
    };
  }, [onCommitSource, applyEdit, history, showHint]);

  // 渐进挂载
  const [mounted, setMounted] = useState(Math.min(3, chunks.length));
  // 只在块数变少时收回：打一个字内容就变一次，要是每次都退回前 3 块，后面的块会卸掉，页面塌缩、滚动跳走、光标找不到落点
  useEffect(() => {
    setMounted((m) => Math.min(Math.max(m, Math.min(3, chunks.length)), chunks.length));
  }, [chunks]);
  useEffect(() => {
    if (mounted >= chunks.length) return;
    const idle =
      "requestIdleCallback" in window
        ? (cb: () => void) => (window as any).requestIdleCallback(cb, { timeout: 300 })
        : (cb: () => void) => setTimeout(cb, 60);
    const h = idle(() => setMounted((m) => Math.min(m + 4, chunks.length)));
    return () => {
      if ("cancelIdleCallback" in window) (window as any).cancelIdleCallback(h);
      else clearTimeout(h as number);
    };
  }, [mounted, chunks.length]);

  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const scrollToHeading = useCallback(
    (id: string) => {
      setMounted(chunks.length);
      setPendingScroll(id);
    },
    [chunks.length],
  );

  // 外部锚点（tab.anchor）：内容分块就绪后跳；chunks 变化会重触发直到命中
  useEffect(() => {
    if (anchor) scrollToHeading(anchor);
  }, [anchor, scrollToHeading]);

  useEffect(() => {
    if (!pendingScroll) return;
    if (mounted < chunks.length) return;
    let raf = 0;
    let tries = 0;
    let lastTop = NaN;
    const tick = () => {
      const el = document.getElementById(pendingScroll);
      const scroller = el?.closest<HTMLElement>(".overflow-y-auto");
      if (el && scroller) {
        const top =
          el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        scroller.scrollTo({ top: Math.max(0, top - 8) });
        if (Math.abs(top - lastTop) < 1) {
          setPendingScroll(null);
          return;
        }
        lastTop = top;
      }
      if (tries++ < 90) raf = requestAnimationFrame(tick);
      else setPendingScroll(null);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pendingScroll, mounted, chunks.length]);

  const urlTransform = useCallback(
    (url: string, key: string) => {
      if (!url || url.startsWith("#")) return url;
      if (isExternalUrl(url)) {
        if (key === "src" && /^https?:|^\/\//i.test(url)) return BLOCKED_IMG + url;
        return url;
      }
      // 库内链接可以带锚（笔记里的页标记 `x.pdf#page=3`）：路径部分解析，锚原样带上
      const hashAt = url.indexOf("#");
      const pathPart = hashAt >= 0 ? url.slice(0, hashAt) : url;
      let decoded = pathPart;
      try {
        decoded = decodeURI(pathPart);
      } catch {
        /* 非法转义就按原样 */
      }
      const resolved = resolveRel(rel, decoded);
      if (!resolved) return "";
      if (key === "src") return backend.fileUrl(resolved);
      return REL_LINK_PREFIX + resolved + (hashAt >= 0 ? url.slice(hashAt) : "");
    },
    [rel],
  );

  /** 审阅标记点击 → 定位弹层 */
  const onMarkClick = useCallback(
    (e: React.MouseEvent, node: any) => {
      if (!onCommitSource) return;
      const cmid = Number(node?.properties?.dataCmid);
      if (!Number.isFinite(cmid)) return;
      e.preventDefault();
      e.stopPropagation();
      const host = bodyRef.current;
      if (!host) return;
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      setPop({ cmid, top: r.bottom - hr.top + 6, left: Math.max(0, r.left - hr.left) });
    },
    [onCommitSource],
  );

  const applyOne = useCallback(
    (cmid: number, accept: boolean) => {
      const seg = segments[cmid];
      if (!seg || !onCommitSource) return;
      setPop(null);
      onCommitSource(resolveMark(src, seg, accept));
    },
    [segments, src, onCommitSource],
  );

  // 组件表的身份必须稳定：每次渲染换一套新函数，React 会把整块正文卸掉重建——选区随之消失、打字后光标与滚动乱跳。
  // 会随内容变的目录表与跳转用 ref 读；每个块的表只建一次
  const tocRef = useRef(tocByLine);
  tocRef.current = tocByLine;
  const scrollToHeadingRef = useRef(scrollToHeading);
  scrollToHeadingRef.current = scrollToHeading;
  const components = useMemo(() => {
    const heading =
      (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", chunkStart: number) =>
      ({ node, children, ...props }: any) => {
        const line = node?.position?.start?.line
          ? chunkStart + node.position.start.line - 1
          : undefined;
        const id = line ? tocRef.current.get(line)?.id : undefined;
        return (
          <Tag id={id} {...props}>
            {children}
          </Tag>
        );
      };
    const markish =
      (Tag: "ins" | "del" | "mark") =>
      ({ node, children, className, ...props }: any) =>
        className?.includes("cm-") ? (
          <Tag
            className={className}
            {...props}
            onClick={(e: React.MouseEvent) => onMarkClick(e, node)}
            role={onCommitSource ? "button" : undefined}
            title={
              node?.properties?.dataAuthor
                ? t("@{0} 的建议 · 点击处理", [node.properties.dataAuthor])
                : onCommitSource
                  ? t("点击处理此建议")
                  : undefined
            }
          >
            {children}
          </Tag>
        ) : (
          <Tag className={className} {...props}>
            {children}
          </Tag>
        );
    const perChunk = new Map<number, Record<string, unknown>>();
    const build = (chunkStart: number) =>
      ({
        h1: heading("h1", chunkStart),
        h2: heading("h2", chunkStart),
        h3: heading("h3", chunkStart),
        h4: heading("h4", chunkStart),
        h5: heading("h5", chunkStart),
        h6: heading("h6", chunkStart),
        ins: markish("ins"),
        del: markish("del"),
        mark: markish("mark"),
        span: ({ node, children, className, ...props }: any) =>
          className?.includes("cm-comment") ? (
            <span
              className={className}
              {...props}
              onClick={(e: React.MouseEvent) => onMarkClick(e, node)}
              role={onCommitSource ? "button" : undefined}
              title={
                node?.properties?.dataAuthor
                  ? t("@{0} 的批注 · 点击处理", [node.properties.dataAuthor])
                  : undefined
              }
            >
              {children}
            </span>
          ) : (
            <span className={className} {...props}>
              {children}
            </span>
          ),
        a: ({ node: _n, href, children, ...props }: any) => (
          <a
            href={href}
            {...props}
            onClick={(e) => {
              // 审阅模式正文可编辑：单击是放光标，按住 MOD 才跟链接
              if (onCommitSource && !annotateOnly && !(e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                return;
              }
              if (typeof href === "string" && href.startsWith(REL_LINK_PREFIX)) {
                e.preventDefault();
                const target = href.slice(REL_LINK_PREFIX.length);
                const hashAt = target.indexOf("#");
                if (hashAt < 0) openFile(target);
                else openFile(target.slice(0, hashAt), target.slice(hashAt + 1));
              } else if (typeof href === "string" && isExternalUrl(href)) {
                e.preventDefault();
                void openExternal(href);
              } else if (typeof href === "string" && href.startsWith("#")) {
                e.preventDefault();
                scrollToHeadingRef.current(href.slice(1));
              }
            }}
          >
            {children}
          </a>
        ),
        img: ({ node: _n, src, alt, ...props }: any) =>
          typeof src === "string" && src.startsWith(BLOCKED_IMG) ? (
            <RemoteImage url={src.slice(BLOCKED_IMG.length)} alt={alt} />
          ) : (
            <img src={src} alt={alt} {...props} />
          ),
        table: ({ node: _n, children, ...props }: any) => (
          <div className="tablewrap">
            <table {...props}>{children}</table>
          </div>
        ),
      }) as Record<string, unknown>;
    return (chunkStart: number) => {
      let c = perChunk.get(chunkStart);
      if (!c) perChunk.set(chunkStart, (c = build(chunkStart)));
      return c;
    };
  }, [openFile, onMarkClick, onCommitSource, annotateOnly]);

  const activeSeg: CriticSegment | undefined = pop ? segments[pop.cmid] : undefined;
  const reviewSlot = useContext(ReviewSlot);
  const reviewBar =
    onCommitSource && counts.actionable > 0 ? (
      <ReviewBar counts={counts} onAll={(accept) => onCommitSource(resolveAll(src, accept))} />
    ) : null;

  return (
    <div ref={bodyRef} className="relative" onMouseUp={onTextSelect}>
      {reviewBar && (reviewSlot ? createPortal(reviewBar, reviewSlot) : <div className="prose-reader mb-4">{reviewBar}</div>)}
      <div className="flex justify-center gap-10">
        <article
          ref={articleRef}
          className="prose-reader min-w-0 flex-1"
          contentEditable={onCommitSource && !annotateOnly ? true : undefined}
          suppressContentEditableWarning
          spellCheck={onCommitSource && !annotateOnly ? false : undefined}
        >
          {chunks.slice(0, mounted).map((c, i) => {
            const p = chunkPipeline(c.src, chunkOffsets[i], segments, !!onCommitSource);
            return (
              <section className="md-chunk" data-chunk={i} key={`${c.startLine}-${i}-${epochs[i] ?? 0}`}>
                <Markdown
                  remarkPlugins={p.remarkPlugins as any[]}
                  rehypePlugins={[...(p.rehypePlugins as any[]), [rehypeTurnLines, changedLines, c.startLine]]}
                  urlTransform={urlTransform}
                  components={components(c.startLine) as any}
                >
                  {p.text}
                </Markdown>
              </section>
            );
          })}
          {mounted < chunks.length && (
            <p className="py-6 text-center font-sans text-[13px] text-muted">
              {t("正在载入其余内容…（")}{mounted}/{chunks.length}{t("）")}
            </p>
          )}
        </article>
        {toc.length > 2 && <Toc items={toc} onJump={scrollToHeading} />}
      </div>
      {hint && onCommitSource && (
        <p
          className="pointer-events-none absolute z-40 max-w-[420px] rounded-[3px] border border-rule bg-card px-2 py-1 font-sans text-[13px] text-accent-warm shadow-[var(--shadow-card)]"
          style={{ top: hint.top, left: Math.min(hint.left, (bodyRef.current?.clientWidth ?? 600) - 420) }}
          role="status"
        >
          {hint.text}
        </p>
      )}
      {selBar && onCommitSource && (
        <div
          className="absolute z-40 flex max-w-[440px] flex-wrap items-center gap-1.5 rounded-[4px] border border-rule bg-card px-2 py-1.5 font-sans text-[13px] shadow-[var(--shadow-card)]"
          style={{ top: selBar.top, left: Math.min(selBar.left, (bodyRef.current?.clientWidth ?? 600) - 360) }}
          role="dialog"
          aria-label={t("添加批注或建议")}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
        >
          <input
            className="w-[230px] rounded-[3px] border border-rule bg-transparent px-2 py-1 text-[13.5px] text-ink focus:outline-none"
            placeholder={selBar.mode !== "comment" ? t("替换为…") : annotateOnly ? t("批注内容…") : t("批注内容…（⌫ 建议删除）")}
            value={selBar.input}
            onChange={(e) => setSelBar({ ...selBar, input: e.target.value, err: null })}
            onKeyDown={(e) => {
              // isComposing：输入法组合中的回车是上屏，不是提交
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                commitAnnotate(selBar.mode, selBar.input);
              } else if ((e.key === "Backspace" || e.key === "Delete") && selBar.input === "" && !annotateOnly) {
                e.preventDefault();
                commitAnnotate("del"); // 空输入框按删除 = 选中文字变划线
              } else if (e.key === "Escape") {
                setSelBar(null);
              }
            }}
          />
          <button
            className="btn btn-outline !py-0.5 !text-[13px] text-accent-cool"
            onClick={() => commitAnnotate(selBar.mode, selBar.input)}
          >
            {selBar.mode === "comment" ? t("加批注") : t("建议替换")}
          </button>
          <button className="btn btn-outline !py-0.5 !text-[13px]" onClick={() => commitAnnotate("mark")}>
            {t("高亮")}
          </button>
          {!annotateOnly && (
            <>
              <button
                className="btn btn-outline !py-0.5 !text-[13px] text-accent-warm"
                title={t("选中文字变成建议删除（快捷键：⌫）")}
                onClick={() => commitAnnotate("del")}
              >
                {t("删除")}
              </button>
              <button
                className="btn btn-outline !py-0.5 !text-[13px]"
                onClick={() =>
                  setSelBar({ ...selBar, mode: selBar.mode === "comment" ? "sub" : "comment", err: null })
                }
              >
                {selBar.mode === "comment" ? t("替换") : t("批注")}
              </button>
            </>
          )}
          <button className="icon-btn !h-5 !w-5" aria-label={t("关闭")} onClick={() => setSelBar(null)}>
            ✕
          </button>
          {selBar.err && <span className="basis-full text-accent-warm">{selBar.err}</span>}
        </div>
      )}
      {pop && activeSeg && (
        <div
          className="absolute z-40 flex items-center gap-1 rounded-[4px] border border-rule bg-card px-2 py-1.5 font-sans text-[13px] shadow-[var(--shadow-card)]"
          style={{ top: pop.top, left: Math.min(pop.left, (bodyRef.current?.clientWidth ?? 600) - 260) }}
          role="dialog"
          aria-label={t("处理审阅标记")}
        >
          {activeSeg.author && (
            <span className="mr-1 text-muted">@{activeSeg.author}</span>
          )}
          {activeSeg.kind === "comment" ? (
            <button className="btn btn-outline !py-0.5 !text-[13px]" onClick={() => applyOne(pop.cmid, true)}>
              {t("标记解决")}
            </button>
          ) : activeSeg.kind === "mark" ? (
            <button className="btn btn-outline !py-0.5 !text-[13px]" onClick={() => applyOne(pop.cmid, true)}>
              {t("取消高亮")}
            </button>
          ) : (
            <>
              <button
                className="btn btn-outline !py-0.5 !text-[13px] text-accent-cool"
                onClick={() => applyOne(pop.cmid, true)}
              >
                {t("接受")}
              </button>
              <button
                className="btn btn-outline !py-0.5 !text-[13px] text-accent-warm"
                onClick={() => applyOne(pop.cmid, false)}
              >
                {t("拒绝")}
              </button>
            </>
          )}
          <button className="icon-btn !h-5 !w-5" aria-label={t("关闭")} onClick={() => setPop(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
});

function ReviewBar({
  counts,
  onAll,
}: {
  counts: ReturnType<typeof countCritic>;
  onAll: (accept: boolean) => void;
}) {
  const [confirm, setConfirm] = useState<null | boolean>(null);
  // 工具栏一档的小字：统计 + 文字按钮，样式同右侧的模式按钮
  const btn = "shrink-0 whitespace-nowrap rounded-[3px] px-2 py-0.5 text-[13px] text-muted hover:bg-[var(--hover-surface)] hover:text-ink";
  return (
    <div className="flex min-w-0 items-center gap-1 font-sans text-[12.5px]">
      <span className="shrink-0 whitespace-nowrap text-muted">
        {counts.ins > 0 && <span className="mr-1.5 text-accent-cool">{counts.ins} {t("增")}</span>}
        {counts.del > 0 && <span className="mr-1.5 text-accent-warm">{counts.del} {t("删")}</span>}
        {counts.sub > 0 && <span className="mr-1.5 text-ink">{counts.sub} {t("替")}</span>}
        {counts.comment > 0 && <span className="mr-1.5">{counts.comment} {t("条批注")}</span>}
      </span>
      {confirm === null ? (
        <>
          <button className={btn} onClick={() => setConfirm(true)}>
            {t("应用改动")}
          </button>
          <button className={btn} onClick={() => setConfirm(false)}>
            {t("拒绝改动")}
          </button>
        </>
      ) : (
        <>
          <span className="truncate text-ink">
            {confirm ? t("应用全部改动并清掉所有批注？") : t("拒绝全部改动并清掉所有批注？")}
          </span>
          <button
            className={`${btn} ${confirm ? "!text-accent-cool" : "!text-accent-warm"}`}
            onClick={() => {
              onAll(confirm);
              setConfirm(null);
            }}
          >
            {t("确认")}
          </button>
          <button className={btn} onClick={() => setConfirm(null)}>
            {t("取消")}
          </button>
        </>
      )}
    </div>
  );
}

function Toc({ items, onJump }: { items: TocItem[]; onJump: (id: string) => void }) {
  const capped = items.slice(0, 200);
  return (
    <nav
      aria-label={t("目录")}
      className="sticky top-0 hidden max-h-[calc(100vh-120px)] w-56 shrink-0 self-start overflow-y-auto border-l border-rule pl-4 xl:block"
    >
      <p className="mb-2 font-sans text-[12.5px] tracking-wide text-muted">{t("目录")}</p>
      <ul className="space-y-1">
        {capped.map((t, i) => (
          <li key={`${t.id}-${i}`} style={{ paddingLeft: (t.level - 1) * 10 }}>
            <button
              className="block w-full truncate text-left font-sans text-[13px] leading-[1.5] text-muted hover:text-ink"
              title={t.text}
              onClick={() => onJump(t.id)}
            >
              {t.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
