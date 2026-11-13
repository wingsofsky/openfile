import { useEffect, useState } from "react";
import { backend } from "../lib/backend";
import type { DiffPair } from "../lib/types";
import type { DiffPayload } from "../state/store";
import { formatBytes } from "../lib/util";
import { t } from "../i18n";

interface Part {
  value: string;
  added?: boolean;
  removed?: boolean;
}

const WORD_DIFF_CAP = 400 * 1024; // 超过退化为行级

/** 词级中文分词 diff：jsdiff 9 + Intl.Segmenter */
export async function computeParts(oldText: string, newText: string): Promise<Part[]> {
  const diff = await import("diff");
  if (oldText.length + newText.length > WORD_DIFF_CAP) {
    return diff.diffLines(oldText, newText);
  }
  try {
    const seg = new Intl.Segmenter("zh-Hans", { granularity: "word" });
    // diffWords ignores whitespace changes; diffWordsWithSpace ignores intlSegmenter.
    // Diff exact segment arrays so either side reconstructs byte-for-byte as JS text.
    const words = (text: string) => Array.from(seg.segment(text), (part) => part.segment);
    return diff.diffArrays(words(oldText), words(newText)).map((part) => ({
      value: part.value.join(""), added: part.added, removed: part.removed,
    }));
  } catch {
    return diff.diffWordsWithSpace(oldText, newText);
  }
}

export function DiffView({ payload }: { payload: DiffPayload }) {
  const [pair, setPair] = useState<DiffPair | null>(null);
  const [parts, setParts] = useState<Part[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    setPair(null);
    setParts(null);
    setError(null);
    backend
      .diffSnapshotFile(payload.path, payload.from, payload.to)
      .then(async (p) => {
        if (dead) return;
        setPair(p);
        if (!p.oldBinary && !p.newBinary) {
          const parts = await computeParts(p.old, p.new);
          if (!dead) setParts(parts);
        }
      })
      .catch((e) => {
        if (!dead) setError(String(e));
      });
    return () => {
      dead = true;
    };
  }, [payload]);

  if (error)
    return <p className="px-8 py-10 font-sans text-[14px] text-accent-warm">{error}</p>;
  if (!pair)
    return <p className="px-8 py-10 font-sans text-[13.5px] text-muted">{t("正在计算差异…")}</p>;
  if (pair.oldBinary || pair.newBinary)
    return (
      <p className="px-8 py-10 font-sans text-[14px] text-muted">
        {t("二进制文件，无法做文本对比。")}
      </p>
    );

  const ins = parts?.filter((p) => p.added).reduce((n, p) => n + p.value.length, 0) ?? 0;
  const del = parts?.filter((p) => p.removed).reduce((n, p) => n + p.value.length, 0) ?? 0;
  const identical = parts !== null && ins === 0 && del === 0;

  return (
    <div className="px-8 py-8">
      <header className="prose-reader mb-5 border-b border-rule pb-3 font-sans text-[13px] text-muted">
        <span className="text-ink">{payload.path}</span>
        <span className="ml-3 tabular-nums">
          {payload.fromLabel ?? payload.from} → {payload.to ?? t("当前")}
        </span>
        <span className="ml-3 tabular-nums">
          <span className="text-accent-cool">+{ins}</span>{" "}
          <span className="text-accent-warm">−{del}</span> {t("字符")}
          {" · "}
          {formatBytes(pair.new.length)}
        </span>
      </header>
      {identical && (
        <p className="prose-reader font-sans text-[14px] text-muted">{t("两个版本内容相同。")}</p>
      )}
      {parts === null && !identical && (
        <p className="font-sans text-[13.5px] text-muted">{t("正在分词…")}</p>
      )}
      <article className="prose-reader whitespace-pre-wrap break-words !text-[16.5px] leading-[1.9]">
        {parts?.map((p, i) =>
          p.added ? (
            <ins key={i} className="diff-ins">
              {p.value}
            </ins>
          ) : p.removed ? (
            <del key={i} className="diff-del">
              {p.value}
            </del>
          ) : (
            <span key={i}>{p.value}</span>
          ),
        )}
      </article>
    </div>
  );
}
