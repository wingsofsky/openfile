import { useCallback, useEffect, useState } from "react";
import { backend } from "../lib/backend";
import type { TextRead } from "../lib/types";
import { formatBytes } from "../lib/util";
import { useApp } from "../state/store";
import { t } from "../i18n";
import { SourceEditor } from "./SourceEditor";
import { TurnReviewHost } from "./ChangeReview";

const STEP_1 = 4 * 1024 * 1024;
const STEP_2 = 16 * 1024 * 1024;
const STEP_3 = 64 * 1024 * 1024;

export function TextView({ rel }: { rel: string }) {
  const [data, setData] = useState<TextRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState(STEP_1);
  const changed = useApp((s) => s.changed);

  const load = useCallback(
    (max: number) => {
      backend
        .readText(rel, max)
        .then((r) => {
          setData(r);
          setError(null);
        })
        .catch((e) => setError(String(e)));
    },
    [rel],
  );

  // 切文件先清旧内容，避免异步读取前闪现上一份
  useEffect(() => {
    setData(null);
    setError(null);
  }, [rel]);
  useEffect(() => load(cap), [load, cap]);
  useEffect(() => {
    if (changed?.paths.includes(rel)) load(cap);
  }, [changed, rel, load, cap]);

  if (error)
    return <p className="px-8 py-10 text-[14px] text-accent-warm">{error}</p>;
  if (!data) return null;

  if (data.encoding === "binary") {
    return (
      <div className="px-8 py-10 text-[14px] text-muted">
        <p>{t("这是一个二进制文件（")}{formatBytes(data.size)}{t("），无法以文本显示。")}</p>
      </div>
    );
  }

  // 能完整读到的 UTF-8 文本直接可编辑；其它编码（存回会改编码）和截断的大文件保持只读
  if (data.encoding === "utf-8" && !data.truncated) {
    return (
      <TurnReviewHost rel={rel}>
        <SourceEditor rel={rel} lang="plain" />
      </TurnReviewHost>
    );
  }

  return (
    <div className="px-8 py-8">
      <div className="mb-3 flex items-center gap-3 font-sans text-[13px] text-muted">
        <span>{formatBytes(data.size)}</span>
        {data.encoding !== "utf-8" && (
          <span className="rounded-[2px] border border-rule px-1">
            {t("按 {0} 解码", [data.encoding])}
          </span>
        )}
        <span>{t("只读")}</span>
        {data.truncated && (
          <button
            className="btn btn-outline !px-2 !py-0.5 !text-[12.5px]"
            onClick={() => setCap(cap === STEP_1 ? STEP_2 : STEP_3)}
          >
            {t("已截断，载入更多")}
          </button>
        )}
      </div>
      <pre className="max-w-full font-mono text-[13.5px] leading-[1.7] whitespace-pre-wrap break-words text-ink">
        {data.content}
      </pre>
    </div>
  );
}
