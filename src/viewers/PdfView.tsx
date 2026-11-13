/**
 * PDF：pdf.js 画页面与文字层，选中文字可「引用到会话」（document-context.ts 认 div.pdf-doc，带页码）。
 * - 字节经 readBinaryB64 取：base64-over-IPC 封顶 32MB（运行时 shadow.ts::MAX_B64_CAP）。更大的退回 WebView 自带的
 *   PDF 查看（iframe 走 asset 协议流式，不能引用选区）；让 pdf.js 直接读 asset 协议要放宽 CSP 的 connect-src，没做。
 * - CMap / 标准字体 / wasm / ICC 由 scripts/pdfjs-assets.mjs 放在 /pdfjs/ 下；CSP 只加了 'wasm-unsafe-eval'。
 * - 页面进到可视区附近才画；容器宽度变了整页重画。
 * - 顶部「Markdown 笔记」：本机 Docling 转成 `<名字>.pdf.md`，在审阅模式里高亮、批注；笔记里的页标记
 *   `x.pdf#page=N` 打开这里时带锚 `page=N`，跳到那一页。PDF 本身只读。
 */
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { backend } from "../lib/backend";
import { useApp } from "../state/store";
import { pdfNotes } from "../lib/file-actions";
import { t } from "../i18n";

/** 与运行时 MAX_B64_CAP 同值：超过它 readBinaryB64 会拒绝 */
const B64_LIMIT = 32 * 1024 * 1024;
const MAX_PAGE_WIDTH = 920;
const asset = (dir: string) => new URL(`/pdfjs/${dir}/`, window.location.href).href;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 页面宽度：跟着滚动容器走，按 40px 取整，免得拖动面板时每帧重画 */
function usePageWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.min(MAX_PAGE_WIDTH, Math.max(320, Math.floor((el.clientWidth - 48) / 40) * 40));
      setWidth((prev) => (prev === w ? prev : w));
    };
    // 先同步量一次：ResizeObserver 的首个回调要等到下一帧
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export function PdfView({ rel, anchor }: { rel: string; anchor?: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.414);
  const [native, setNative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = useApp((s) => s.changed);
  const reloadTick = changed?.paths.includes(rel) ? changed.ts : 0;
  const hostRef = useRef<HTMLDivElement>(null);
  const width = usePageWidth(hostRef);
  const [converting, setConverting] = useState(false);

  // 带锚 `page=N` 打开（笔记里的页标记）：页面占位按估计高度排好，直接滚到那一页
  useEffect(() => {
    const n = /^page=(\d+)$/.exec(anchor ?? "")?.[1];
    if (!n || !doc || width === 0) return;
    hostRef.current?.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: "start" });
  }, [anchor, doc, width]);

  const notes = async () => {
    setConverting(true);
    try {
      await pdfNotes(rel);
    } finally {
      setConverting(false);
    }
  };

  useEffect(() => {
    let dead = false;
    let task: { destroy(): Promise<void> } | null = null;
    setDoc(null);
    setError(null);
    setNative(false);
    (async () => {
      const entry = await backend.statFile(rel);
      if (entry.size > B64_LIMIT) {
        if (!dead) setNative(true);
        return;
      }
      const { b64 } = await backend.readBinaryB64(rel);
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const loading = pdfjs.getDocument({
        data: b64ToBytes(b64),
        cMapUrl: asset("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: asset("standard_fonts"),
        wasmUrl: asset("wasm"),
        iccUrl: asset("iccs"),
        enableXfa: false,
      });
      // 读字节期间已经换了文件 / 关了标签：清理时 task 还是空的，这里自己销毁，免得留下 worker
      if (dead) {
        void loading.destroy();
        return;
      }
      task = loading;
      const loaded = await loading.promise;
      const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
      if (dead) return;
      setRatio(first.height / first.width);
      setDoc(loaded);
    })().catch((e) => {
      if (!dead) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      dead = true;
      void task?.destroy();
    };
  }, [rel, reloadTick]);

  if (native)
    return (
      <div className="flex h-full flex-col">
        <p className="shrink-0 border-b border-rule px-3 py-1.5 font-sans text-[12.5px] text-muted">
          {t("文件超过 32MB，用系统自带的 PDF 查看（不能引用选区）。")}
        </p>
        <iframe src={backend.fileUrl(rel)} title={rel} className="min-h-0 w-full flex-1 border-0" />
      </div>
    );
  if (error)
    return <p className="px-8 py-10 font-sans text-[14px] text-accent-warm">{t("无法打开这份 PDF：{0}", [error])}</p>;

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-rule bg-card px-3 py-1.5 font-sans text-[13px] text-muted">
        <span className="flex-1">
          {converting
            ? t("正在用 Docling 转换…（首次会下载模型，可能要几分钟）")
            : t("转成 Markdown 笔记后可以高亮、批注，每页都能跳回 PDF，原文件不动。")}
        </span>
        <button className="btn btn-outline !py-0.5 !text-[13px]" disabled={converting} onClick={() => void notes()}>
          {t("Markdown 笔记")}
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-y-auto">
        {!doc || width === 0 ? (
          <p className="px-8 py-10 font-sans text-[13.5px] text-muted">{t("正在打开 PDF…")}</p>
        ) : (
          <div className="pdf-doc py-6">
            {Array.from({ length: doc.numPages }, (_, i) => (
              <PdfPage key={`${i + 1}:${width}`} doc={doc} n={i + 1} width={width} estimate={width * ratio} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfPage({ doc, n, width, estimate }: { doc: PDFDocumentProxy; n: number; width: number; estimate: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let render: RenderTask | null = null;
    let text: TextLayer | null = null;
    let started = false;
    let dead = false;
    const draw = async () => {
      const pdfjs = await import("pdfjs-dist");
      const page = await doc.getPage(n);
      if (dead) return;
      const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
      // 实际尺寸覆盖估计值；文字层按 --total-scale-factor 定位
      el.style.height = `${viewport.height}px`;
      el.style.setProperty("--scale-factor", String(viewport.scale));
      el.style.setProperty("--total-scale-factor", String(viewport.scale));
      const canvas = el.querySelector("canvas")!;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      render = page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: el.querySelector<HTMLDivElement>(".textLayer")!, viewport });
      await Promise.all([render.promise, text.render()]);
    };
    // root 必须是滚动容器：缺省的视口 root 会先被容器裁掉，rootMargin 的提前量就没了
    const io = new IntersectionObserver((entries) => {
      if (started || !entries.some((e) => e.isIntersecting)) return;
      started = true;
      io.disconnect();
      // 换宽度 / 关标签时取消的渲染会以拒绝结束，不算错
      draw().catch(() => {});
    }, { root: el.closest(".pdf-doc")?.parentElement, rootMargin: "100% 0px" });
    io.observe(el);
    return () => {
      dead = true;
      io.disconnect();
      render?.cancel();
      text?.cancel();
    };
  }, [doc, n, width]);
  return (
    <div ref={ref} data-page={n} className="pdf-page" style={{ width, height: estimate }}>
      <canvas />
      <div className="textLayer" />
    </div>
  );
}
