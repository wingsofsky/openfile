import { useEffect, useState } from "react";
import { File } from "@phosphor-icons/react";
import { backend } from "../lib/backend";
import type { Entry } from "../lib/types";
import { baseName, formatBytes } from "../lib/util";
import { t } from "../i18n";

export function BinaryView({ rel }: { rel: string }) {
  const [meta, setMeta] = useState<Entry | null>(null);
  useEffect(() => {
    // stat 走 readText 之外的轻通道不存在时退化为忽略错误
    backend
      .readText(rel, 1)
      .then((r) => setMeta({ name: baseName(rel), rel, isDir: false, size: r.size, mtime: 0, ext: "" }))
      .catch(() => setMeta(null));
  }, [rel]);

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <File size={34} className="text-muted" aria-hidden />
      <p className="text-[15px] text-ink">{baseName(rel)}</p>
      <p className="font-sans text-[13px] text-muted">
        {t("该格式暂不支持预览")}{meta ? ` · ${formatBytes(meta.size)}` : ""}
      </p>
    </div>
  );
}
