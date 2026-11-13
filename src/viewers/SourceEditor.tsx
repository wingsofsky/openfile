/**
 * 编辑模式：CodeMirror 6 直接编辑 md（IME 金标准路径）；纯文本（txt 等）用同一个编辑器，lang="plain"。
 * 两种 lang 字号与底色都同审阅（正文 18px、随界面缩放，通体纸色）。
 * - ⌘S 保存（scoped 原子写），带完整基线：磁盘在此期间被改过就拒绝、出冲突横幅，不静默覆盖
 * - CriticMarkup / 【…】语法高亮（行内；跨行标记只亮首行，够用）——两种 lang 都亮
 * - 建议工具条（只在 markdown）：选中文本一键包成 删除/替换 建议，光标处插入 插入/批注
 * - agent 同时改盘：未脏则静默重载；已脏则出横幅二选一（「保持我的版本」以当时的磁盘内容为新基线）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState, Prec } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown as cmMarkdown } from "@codemirror/lang-markdown";
import { backend } from "../lib/backend";
import { AGENT_NOTE_PATTERN, makeCritic } from "@openfile/protocol/criticmarkup";
import { detectEol, withEol, type Eol } from "@openfile/protocol/eol";
import { useApp } from "../state/store";
import { t } from "../i18n";
import { MOD } from "../lib/util";

const EDIT_CAP = 8 * 1024 * 1024;

const criticDeco = new MatchDecorator({
  regexp: new RegExp(String.raw`\{\+\+.*?\+\+\}|\{--.*?--\}|\{~~.*?~~\}|\{>>.*?<<\}|\{==.*?==\}|` + AGENT_NOTE_PATTERN, "g"),
  decoration: (m) => {
    const t = m[0];
    const cls = t.startsWith("{++")
      ? "cmk-ins"
      : t.startsWith("{--")
        ? "cmk-del"
        : t.startsWith("{~~")
          ? "cmk-sub"
          : t.startsWith("{>>")
            ? "cmk-comment"
            : t.startsWith("{==")
              ? "cmk-mark"
              : "cmk-agent";
    return Decoration.mark({ class: cls });
  },
});

const criticHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = criticDeco.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = criticDeco.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** 编辑模式：字号与底色同审阅（正文 18px、随界面缩放；行号栏不另起底色）。压在 editorTheme 之上 */
const proseTheme = Prec.highest(
  EditorView.theme({
    // 只放大正文：设在 "&" 上会连查找面板等一起变大
    ".cm-content": { fontSize: "calc(18px * var(--prose-scale, 1))" },
    ".cm-gutters": { backgroundColor: "var(--color-paper)" },
  }),
);

export const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--color-paper)",
    color: "var(--color-ink)",
    fontSize: "13.5px",
    height: "100%",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.75",
    padding: "16px 8px",
    caretColor: "var(--color-ink)",
  },
  ".cm-cursor": { borderLeftColor: "var(--color-ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "var(--color-panel)",
    color: "var(--color-muted)",
    border: "none",
    fontFamily: "var(--font-mono)",
    fontSize: "11.5px",
  },
  ".cm-activeLine": { backgroundColor: "var(--hover-surface)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--hover-surface)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--color-accent-cool) 22%, transparent) !important",
  },
  ".cmk-ins": {
    backgroundColor: "color-mix(in srgb, var(--color-accent-cool) 14%, transparent)",
  },
  ".cmk-del": {
    backgroundColor: "color-mix(in srgb, var(--color-accent-warm) 12%, transparent)",
    textDecoration: "line-through",
  },
  ".cmk-sub": {
    backgroundColor: "color-mix(in srgb, var(--color-accent-cool) 10%, transparent)",
    borderBottom: "1px dashed var(--color-accent-cool)",
  },
  ".cmk-comment": {
    backgroundColor: "var(--color-panel)",
    color: "var(--color-muted)",
    fontStyle: "italic",
  },
  ".cmk-mark": {
    backgroundColor: "color-mix(in srgb, var(--color-accent-warm) 18%, transparent)",
  },
  ".cmk-agent": {
    color: "var(--color-accent-cool)",
    backgroundColor: "color-mix(in srgb, var(--color-accent-cool) 8%, transparent)",
  },
});

export function SourceEditor({ rel, lang = "markdown" }: { rel: string; lang?: "markdown" | "plain" }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 编辑器内容对应的「上次读到 / 写入的磁盘全文」；保存时作为基线交给后端逐字节比对
  const savedRef = useRef<string>("");
  // 「保持我的版本」时的磁盘全文：下次保存以它为基线（用户已明确选择覆盖这一版）
  const baseRef = useRef<string | null>(null);
  // CM6 把 \r\n 规整成 \n：记下文件主导的换行，存回与比较时还原（用户文库的 CRLF 原样保留）
  const eolRef = useRef<Eol>("\n");
  const textOf = (v: EditorView) => withEol(v.state.doc.toString(), eolRef.current);
  const [dirty, setDirty] = useState(false);
  const [tooBig, setTooBig] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [diskConflict, setDiskConflict] = useState(false);
  const [savedFlash, setSavedFlash] = useState(0);
  const [author, setAuthor] = useState("我");
  const changed = useApp((s) => s.changed);
  const root = useApp((s) => s.lib?.root);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const save = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const content = textOf(view);
    backend
      .writeText(rel, content, root, baseRef.current ?? savedRef.current)
      .then(() => {
        savedRef.current = content;
        baseRef.current = null;
        setDirty(false);
        setDiskConflict(false);
        setSaveError(null);
        setSavedFlash(Date.now());
      })
      // 失败不换掉编辑器：未保存的内容必须还在眼前
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("文件已更改")) setDiskConflict(true);
        else setSaveError(msg);
      });
  }, [rel, root]);
  const saveRef = useRef(save);
  saveRef.current = save;

  // 初始化编辑器
  useEffect(() => {
    let dead = false;
    setError(null);
    setTooBig(false);
    setDirty(false);
    setSaveError(null);
    setDiskConflict(false);
    baseRef.current = null;
    backend
      .readText(rel, EDIT_CAP)
      .then((r) => {
        if (dead || !hostRef.current) return;
        if (r.truncated) {
          setTooBig(true);
          return;
        }
        savedRef.current = r.content;
        eolRef.current = detectEol(r.content);
        const state = EditorState.create({
          doc: r.content,
          extensions: [
            basicSetup,
            lang === "markdown" ? cmMarkdown() : [],
            EditorView.lineWrapping,
            editorTheme,
            proseTheme,
            criticHighlight,
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  saveRef.current();
                  return true;
                },
              },
            ]),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) {
                // 与载入时 CM 看到的样子比（CM 把 \r\n、\r 都当换行），混合换行的文件刚打开不会误报未保存
                setDirty(u.state.doc.toString() !== savedRef.current.replace(/\r\n?/g, "\n"));
              }
            }),
          ],
        });
        const view = new EditorView({ state, parent: hostRef.current });
        viewRef.current = view;
      })
      .catch((e) => {
        if (!dead) setError(String(e));
      });
    return () => {
      dead = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [rel, lang]);

  // agent 改盘
  useEffect(() => {
    if (!changed?.paths.includes(rel)) return;
    const view = viewRef.current;
    if (!view) return;
    backend
      .readText(rel, EDIT_CAP)
      .then((r) => {
        if (r.content === textOf(view)) return; // 是我们自己写的
        if (!dirtyRef.current) {
          savedRef.current = r.content;
          eolRef.current = detectEol(r.content);
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: r.content },
          });
          setDirty(false);
        } else {
          setDiskConflict(true);
        }
      })
      .catch(() => {});
  }, [changed, rel]);

  useEffect(() => {
    backend.getUserName().then(setAuthor).catch(() => {});
  }, []);

  const insertAtSelection = useCallback(
    (mode: "del" | "sub" | "ins" | "comment") => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const sel = view.state.sliceDoc(from, to);
      let text: string;
      let cursorOffset: number;
      switch (mode) {
        case "del":
          text = makeCritic.del(sel || "要删除的文字", author);
          cursorOffset = text.length;
          break;
        case "sub":
          text = makeCritic.sub(sel || "原文", "", author);
          cursorOffset = text.length - 3; // 光标停在 ~>_~~} 的新文位置
          break;
        case "ins":
          text = makeCritic.ins(sel || "", author);
          cursorOffset = text.length - 3; // 停在 ++}| 前
          break;
        case "comment":
          text = makeCritic.comment("", author);
          cursorOffset = text.length - 3;
          break;
      }
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + cursorOffset },
      });
      view.focus();
    },
    [author],
  );

  if (tooBig)
    return (
      <p className="px-8 py-10 font-sans text-[14px] text-muted">
        {t("文件超过 8MB，编辑模式暂不支持（阅读模式不受限）。")}
      </p>
    );
  if (error)
    return <p className="px-8 py-10 font-sans text-[14px] text-accent-warm">{error}</p>;

  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-3 py-1.5 font-sans text-[13px]">
        {lang === "markdown" && <>
        <span className="mr-1 text-muted">{t("建议：")}</span>
        <button className="btn btn-outline !py-0.5 !text-[13px]" title={t("把选中文字标记为建议删除")} onClick={() => insertAtSelection("del")}>
          {t("删除")}
        </button>
        <button className="btn btn-outline !py-0.5 !text-[13px]" title={t("把选中文字标记为建议替换")} onClick={() => insertAtSelection("sub")}>
          {t("替换")}
        </button>
        <button className="btn btn-outline !py-0.5 !text-[13px]" title={t("在光标处插入建议新增")} onClick={() => insertAtSelection("ins")}>
          {t("插入")}
        </button>
        <button className="btn btn-outline !py-0.5 !text-[13px]" title={t("在光标处插入批注")} onClick={() => insertAtSelection("comment")}>
          {t("批注")}
        </button>
        <span className="ml-1 text-muted">{t("署名 @")}{author}</span>
        </>}
        <span className="flex-1" />
        {saveError && <span className="text-accent-warm">{t("保存失败：{0}", [saveError])}</span>}
        {savedFlash > 0 && !dirty && <SavedFlash key={savedFlash} />}
        {dirty && <span className="text-accent-warm">{t("未保存")}</span>}
        <button className="btn btn-primary !py-0.5 !text-[13px]" onClick={save} disabled={!dirty}>
          {t("保存 {0}S", [MOD])}
        </button>
      </div>
      {diskConflict && (
        <div className="flex items-center gap-2 border-b border-rule bg-card px-3 py-1.5 font-sans text-[13px] text-accent-warm">
          {t("磁盘上的文件被改动了（可能是 agent），与你未保存的编辑冲突。")}
          <button
            className="btn btn-outline !py-0.5 !text-[13px]"
            onClick={() => {
              const view = viewRef.current;
              if (!view) return;
              backend.readText(rel, EDIT_CAP).then((r) => {
                savedRef.current = r.content;
                eolRef.current = detectEol(r.content);
                baseRef.current = null;
                view.dispatch({
                  changes: { from: 0, to: view.state.doc.length, insert: r.content },
                });
                setDirty(false);
                setDiskConflict(false);
              }).catch((e) => setSaveError(e instanceof Error ? e.message : String(e)));
            }}
          >
            {t("载入磁盘版（丢弃我的编辑）")}
          </button>
          <button
            className="btn btn-outline !py-0.5 !text-[13px]"
            onClick={() => {
              // 以「现在」的磁盘版为基线：之后若又被改，保存仍会被拒，不会盖掉没见过的版本
              backend.readText(rel, EDIT_CAP).then((r) => {
                baseRef.current = r.content;
                setDirty(true);
                setDiskConflict(false);
              }).catch((e) => setSaveError(e instanceof Error ? e.message : String(e)));
            }}
          >
            {t("保持我的版本（保存时覆盖）")}
          </button>
        </div>
      )}
      <div ref={hostRef} className="min-h-0 overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto" />
    </div>
  );
}

function SavedFlash() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setOn(false), 1600);
    return () => clearTimeout(t);
  }, []);
  return on ? <span className="text-accent-cool">{t("已保存")}</span> : null;
}
