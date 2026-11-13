import { lazy, Suspense, useEffect, useRef } from "react";
import { useApp } from "../state/store";
import { extOf, viewerKindOf } from "../lib/util";
import { MarkdownTab } from "./MarkdownTab";
import { TextView } from "./TextView";
import { HtmlView } from "./HtmlView";
import { DocxView } from "./DocxView";
import { PdfView } from "./PdfView";
import { ImageView } from "./ImageView";
import { BinaryView } from "./BinaryView";
import { DiffView } from "./DiffView";
import { t } from "../i18n";

// The DEV branch is removed at build time, including the editor experiment dependencies.
const SpikePage = import.meta.env.DEV
  ? lazy(() => import("../spike/SpikePage").then((m) => ({ default: m.SpikePage })))
  : null;

/** 每个 tab 的滚动位置（切 tab 只挂载激活者，位置在这里续命） */
const scrollMemo = new Map<string, number>();

export function ViewerHost() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = tabs.find((t) => t.id === activeId) ?? null;

  // 关闭的 tab 清掉滚动记忆，防 Map 无限增长（审查发现：scrollMemo leak）
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    for (const id of scrollMemo.keys()) if (!live.has(id)) scrollMemo.delete(id);
  }, [tabs]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    const target = scrollMemo.get(active.id) ?? 0;
    // 异步视图（md/docx/图片）挂载时高度还是 0，直接赋值会被夹到 0。
    // 用 ResizeObserver 在内容长够之前反复重放目标位置（审查发现 #6）。
    let restored = target === 0;
    el.scrollTop = target;
    const ro = new ResizeObserver(() => {
      if (!restored && el.scrollHeight >= target + el.clientHeight) {
        el.scrollTop = target;
        restored = true;
      }
    });
    ro.observe(el);
    const onScroll = () => {
      restored = true; // 用户一旦滚动就停止自动重放
      scrollMemo.set(active.id, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [active]);

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center text-[14px] text-muted">
        <p>{t("打开一份文档开始阅读")}</p>
      </div>
    );
  }

  if (active.kind === "spike") {
    if (!SpikePage) return null;
    return (
      <div className="min-h-0 overflow-y-auto" ref={scrollRef}>
        <Suspense fallback={<p>{t("正在载入…")}</p>}><SpikePage /></Suspense>
      </div>
    );
  }

  if (active.kind === "diff" && active.diff) {
    return (
      <div className="min-h-0 overflow-y-auto" ref={scrollRef}>
        <DiffView payload={active.diff} />
      </div>
    );
  }

  const kind = viewerKindOf(extOf(active.rel));
  // iframe 类视图自带滚动，不包外层滚动容器
  if (kind === "html" || kind === "pdf") {
    return kind === "html" ? <HtmlView key={active.id} rel={active.rel} /> : <PdfView key={active.id} rel={active.rel} anchor={active.anchor} />;
  }

  // md 有自己的双模式壳（内部自带滚动容器）
  if (kind === "markdown") {
    return <MarkdownTab key={active.id} rel={active.rel} anchor={active.anchor} />;
  }

  return (
    <div key={active.id} className="h-full min-h-0 overflow-y-auto" ref={scrollRef}>
      {kind === "text" && <TextView rel={active.rel} />}
      {kind === "docx" && <DocxView rel={active.rel} />}
      {kind === "image" && <ImageView rel={active.rel} />}
      {kind === "binary" && <BinaryView rel={active.rel} />}
    </div>
  );
}
