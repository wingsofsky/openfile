import { useState } from "react";
import { backend } from "../lib/backend";
import { baseName } from "../lib/util";

export function ImageView({ rel }: { rel: string }) {
  const [dims, setDims] = useState<string | null>(null);
  return (
    <figure className="flex min-h-full flex-col items-center justify-center gap-3 p-8">
      <img
        src={backend.fileUrl(rel)}
        alt={baseName(rel)}
        className="max-h-[80vh] max-w-full rounded-[2px] border border-rule"
        onLoad={(e) => {
          const img = e.currentTarget;
          setDims(`${img.naturalWidth} × ${img.naturalHeight}`);
        }}
      />
      <figcaption className="font-sans text-[13px] text-muted">
        {baseName(rel)}
        {dims ? ` · ${dims}` : ""}
      </figcaption>
    </figure>
  );
}
