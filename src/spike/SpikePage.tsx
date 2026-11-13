/**
 * 输入法与渲染试验场（只在开发模式里有）：
 * ① WKWebView 中文/日文 IME × ProseMirror 建议标记 —— 组合输入事件全程记录，
 *    人肉输入 30 秒即可判定重复/丢字；附合成事件模拟做接线自检。
 * ② CodeMirror 6 对照组（IME 金标准）。
 * ③ 20 万字 markdown 渲染与滚动性能量测。
 * 结果面板可一键复制，贴进 issue。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Schema } from "prosemirror-model";
import { nodes, marks } from "prosemirror-schema-basic";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import {
  addSuggestionMarks,
  suggestChanges,
  withSuggestChanges,
  toggleSuggestChanges,
  applySuggestions,
  revertSuggestions,
  isSuggestChangesEnabled,
} from "@handlewithcare/prosemirror-suggest-changes";
import { EditorView as CmView, minimalSetup } from "codemirror";
import { markdown as cmMarkdown } from "@codemirror/lang-markdown";
import { MarkdownBody } from "../viewers/MarkdownView";

const pmSchema = new Schema({
  nodes: {
    ...nodes,
    doc: { ...nodes.doc, marks: "insertion modification deletion" },
  },
  marks: addSuggestionMarks(marks),
});

interface LogLine {
  t: number;
  kind: string;
  detail: string;
}

function now() {
  return performance.now();
}

export function SpikePage() {
  return (
    <div className="mx-auto max-w-[880px] px-8 py-10 font-sans">
      <h1 className="font-serif text-[22px] font-bold text-ink">IME / 性能试验场</h1>
      <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
        输入法探针：在真实 WKWebView 里，用拼音/日文输入法在「建议模式」开启的编辑器中连续输入，
        观察日志有无 重复字符 / 丢字 / 组合中断。CM6 为对照组。
      </p>
      <PmSpike />
      <CmSpike />
      <PerfSpike />
    </div>
  );
}

/* ---------------- ProseMirror + suggest-changes ---------------- */

function PmSpike() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [anomalies, setAnomalies] = useState(0);

  const log = useCallback((kind: string, detail: string) => {
    setLogs((ls) => [...ls.slice(-199), { t: now(), kind, detail }]);
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    const doc = pmSchema.node("doc", null, [
      pmSchema.node("paragraph", null, [
        pmSchema.text(
          "在这里用中文输入法打字。开启建议模式后，输入会以插入标记出现，删除会变成删除标记。",
        ),
      ]),
    ]);
    const state = EditorState.create({
      schema: pmSchema,
      doc,
      plugins: [
        history(),
        keymap({ "Mod-z": undo, "Mod-Shift-z": redo, "Mod-y": redo }),
        keymap(baseKeymap),
        suggestChanges(),
      ],
    });
    const view = new EditorView(hostRef.current, {
      state,
      dispatchTransaction: withSuggestChanges(),
      handleDOMEvents: {
        compositionstart: (_v, e) => {
          log("comp:start", JSON.stringify((e as CompositionEvent).data ?? ""));
          return false;
        },
        compositionupdate: (_v, e) => {
          log("comp:update", JSON.stringify((e as CompositionEvent).data ?? ""));
          return false;
        },
        compositionend: (v, e) => {
          const data = (e as CompositionEvent).data ?? "";
          log("comp:end", JSON.stringify(data));
          // 简易异常探测：提交串在文档中出现两次相邻（重复插入的典型形态）
          setTimeout(() => {
            if (!data) return;
            const text = v.state.doc.textContent;
            if (data.length > 0 && text.includes(data + data)) {
              setAnomalies((n) => n + 1);
              log("⚠️ anomaly", `疑似重复插入: ${JSON.stringify(data)}`);
            }
          }, 50);
          return false;
        },
        beforeinput: (_v, e) => {
          const ie = e as InputEvent;
          log("beforeinput", `${ie.inputType} ${JSON.stringify(ie.data ?? "")}`);
          return false;
        },
      },
    });
    viewRef.current = view;
    return () => view.destroy();
  }, [log]);

  const refreshSuggesting = () => {
    const v = viewRef.current;
    if (v) setSuggesting(isSuggestChangesEnabled(v.state));
  };

  const run = (cmd: (state: EditorState, dispatch?: (tr: any) => void) => boolean) => {
    const v = viewRef.current;
    if (!v) return;
    cmd(v.state, v.dispatch);
    v.focus();
    refreshSuggesting();
  };

  const simulate = () => {
    const el = hostRef.current?.querySelector(".ProseMirror") as HTMLElement | null;
    if (!el) return;
    el.focus();
    const fire = (type: string, data: string) =>
      el.dispatchEvent(
        new CompositionEvent(type, { data, bubbles: true, cancelable: true }),
      );
    fire("compositionstart", "");
    fire("compositionupdate", "ni");
    fire("compositionupdate", "nihao");
    fire("compositionend", "你好");
    log("simulate", "合成事件序列已派发（真实 IME 行为仍需人工输入验证）");
  };

  return (
    <section className="mt-8">
      <h2 className="text-[16px] font-semibold text-ink">
        ① ProseMirror + suggest-changes{" "}
        <span className={`ml-2 rounded-[2px] border px-1.5 py-0.5 text-[12.5px] ${anomalies ? "border-accent-warm text-accent-warm" : "border-rule text-muted"}`}>
          异常 {anomalies}
        </span>
      </h2>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          className={`btn ${suggesting ? "btn-primary" : "btn-outline"}`}
          onClick={() => run(toggleSuggestChanges)}
        >
          建议模式：{suggesting ? "开" : "关"}
        </button>
        <button className="btn btn-outline" onClick={() => run(applySuggestions)}>
          全部接受
        </button>
        <button className="btn btn-outline" onClick={() => run(revertSuggestions)}>
          全部拒绝
        </button>
        <button className="btn" onClick={simulate}>
          模拟合成输入
        </button>
        <button className="btn" onClick={() => setLogs([])}>
          清空日志
        </button>
      </div>
      <div
        ref={hostRef}
        className="spike-pm prose-reader mt-3 min-h-24 rounded-[3px] border border-rule bg-card px-4 py-3 !text-[16px]"
      />
      <EventLog logs={logs} />
    </section>
  );
}

function EventLog({ logs }: { logs: LogLine[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [logs]);
  const text = logs
    .map((l) => `${l.t.toFixed(0).padStart(8)}ms  ${l.kind.padEnd(12)} ${l.detail}`)
    .join("\n");
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted">组合输入事件日志（最近 200 条）</p>
        <button
          className="btn !py-0.5 !text-[12.5px]"
          onClick={() => void navigator.clipboard.writeText(text)}
        >
          复制
        </button>
      </div>
      <pre
        ref={ref}
        className="mt-1 max-h-40 overflow-y-auto rounded-[3px] border border-rule bg-panel p-2 font-mono text-[12.5px] leading-[1.6] text-muted"
      >
        {text || "（等待输入）"}
      </pre>
    </div>
  );
}

/* ---------------- CodeMirror 6 对照组 ---------------- */

function CmSpike() {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new CmView({
      parent: hostRef.current,
      doc: "# 对照组\n\n在这里用同一个输入法打同样的字，对比行为差异。\n",
      extensions: [minimalSetup, cmMarkdown()],
    });
    return () => view.destroy();
  }, []);
  return (
    <section className="mt-8">
      <h2 className="text-[16px] font-semibold text-ink">② CodeMirror 6 对照组</h2>
      <div
        ref={hostRef}
        className="mt-3 rounded-[3px] border border-rule bg-card [&_.cm-editor]:max-h-40 [&_.cm-editor]:font-mono [&_.cm-editor]:text-[14px]"
      />
    </section>
  );
}

/* ---------------- 200k 字渲染性能 ---------------- */

function gen200k(): string {
  const zh =
    "雨在黄昏时分落下来，屋檐下的灯一盏一盏亮起。他把稿纸摊开，听见远处有火车驶过的声音，像一句没有写完的长句。";
  const en =
    "The evening rain kept its own ledger, and the lamps came on one by one beneath the eaves. ";
  const parts: string[] = ["# 二十万字压力测试\n"];
  let words = 0;
  let ch = 1;
  while (words < 200_000) {
    parts.push(`\n## 第${ch}章 雨夜（${ch}）\n`);
    for (let p = 0; p < 14; p++) {
      const para = (zh + en).repeat(3);
      parts.push("\n" + para + "\n");
      words += 160; // 每段约 160 词/字计
    }
    ch++;
  }
  return parts.join("");
}

function PerfSpike() {
  const [src, setSrc] = useState<string | null>(null);
  const [firstPaint, setFirstPaint] = useState<number | null>(null);
  const [fps, setFps] = useState<string | null>(null);
  const startRef = useRef(0);
  const scrollBoxRef = useRef<HTMLDivElement>(null);

  const start = () => {
    startRef.current = now();
    setFirstPaint(null);
    setFps(null);
    const text = gen200k();
    setSrc(text);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setFirstPaint(now() - startRef.current)),
    );
  };

  const measureScroll = () => {
    const box = scrollBoxRef.current;
    if (!box) return;
    box.scrollTop = 0;
    const frames: number[] = [];
    let last = now();
    let running = true;
    const step = () => {
      if (!running) return;
      box.scrollBy(0, 60);
      const t = now();
      frames.push(t - last);
      last = t;
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 10 || frames.length > 600) {
        running = false;
        const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
        const jank = frames.filter((f) => f > 32).length;
        setFps(
          `平均帧间隔 ${avg.toFixed(1)}ms（≈${(1000 / avg).toFixed(0)}fps）· >32ms 卡帧 ${jank}/${frames.length}`,
        );
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  return (
    <section className="mt-8">
      <h2 className="text-[16px] font-semibold text-ink">③ 20 万字渲染 / 滚动</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" onClick={start}>
          生成并渲染 20 万字
        </button>
        {src && (
          <button className="btn btn-outline" onClick={measureScroll}>
            自动滚动测帧率
          </button>
        )}
        <span className="text-[13px] text-muted">
          {firstPaint !== null && `首屏 ${firstPaint.toFixed(0)}ms`}
          {fps && ` · ${fps}`}
        </span>
      </div>
      {src && (
        <div
          ref={scrollBoxRef}
          className="mt-3 max-h-[420px] overflow-y-auto rounded-[3px] border border-rule bg-card px-6 py-4"
        >
          <MarkdownBody src={src} rel="__spike__/perf.md" />
        </div>
      )}
    </section>
  );
}
