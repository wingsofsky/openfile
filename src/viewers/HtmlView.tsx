import { useEffect, useRef, useState } from "react";
import { backend } from "../lib/backend";
import { isExternalUrl, parentOf, resolveRel } from "../lib/util";
import { openExternal } from "../lib/external";
import { useApp } from "../state/store";
import { LINK_TAP_JS } from "./linktap";
import { reviewHtml } from "../lib/file-actions";
import { t } from "../i18n";

const FULL_CAP = 64 * 1024 * 1024;

/**
 * 可信前缀：标准模式 doctype / head → CSP → base → 链接接管脚本 → 原文。
 *
 * 链接接管（修「点内链白屏」）：<base> 会让 `#锚点` 解析成「基址#锚点」，
 * 沙箱 iframe 于是真的导航离开 srcdoc（asset/桥 URL 在子框架里是白屏）。
 * 所以锚点一律拦下来在文档内滚动；其余链接 postMessage 交宿主路由——
 * 库内文件开 tab、http(s) 走系统浏览器，与 MarkdownView 同一套语义。
 */
export function buildSrcdoc(source: string, baseHref: string): string {
  const baseTag = `<base href="${baseHref.replace(/"/g, "%22")}">`;
  const baseUrl = new URL(baseHref, window.location.href);
  // baseHref comes from the scoped backend, never from the report. Allow its local
  // resource origin, not arbitrary remote images/styles/fonts. Packaged srcdoc also
  // inherits the stricter shell CSP; this meta can only narrow that policy.
  const localSource = baseUrl.protocol === "asset:" ? "asset:" : baseUrl.origin;
  const cspTag =
    `<meta http-equiv="Content-Security-Policy" content="` +
    `default-src 'none'; img-src ${localSource} data: blob:; media-src ${localSource} data: blob:; ` +
    `style-src 'unsafe-inline' ${localSource}; font-src ${localSource} data:; script-src 'unsafe-inline'; ` +
    `connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri ${localSource}">`;
  // 接管脚本独立成模块：它的字节与 tauri.conf.json CSP 的 sha256 是契约
  const linkTap = `<script>${LINK_TAP_JS}</script>`;
  // Never find an insertion point in untrusted markup: a comment can fake <head>,
  // and resources before the real head could load before a later CSP. Keep the
  // trusted head open; HTML parsing handles the source's duplicate head/doctype
  // and retains its title/styles/body while the first doctype sets standards mode.
  return `<!doctype html><html><head>${cspTag}${baseTag}${linkTap}${source}`;
}

/**
 * HTML 报告渲染：读入源码 → 注入 <base>（相对资源按原目录解析）→ sandbox srcdoc。
 * 选 srcdoc 而非 src 直连：行为在 WKWebView / WebView2 / 浏览器 dev 三端一致，
 * 且规避某些宿主对子框架导航的拦截。sandbox 只给 allow-scripts：
 * 内联图表脚本能跑，但拿不到应用 DOM / 存储。
 */
export function HtmlView({ rel }: { rel: string }) {
  // key 必须随内容一起换：srcdoc 在已挂载的 iframe 上热替换，Chromium 与
  // WKWebView 都可能白渲染（实测：第二个 html tab 内容正确但空白）。
  // 每份文档 = 一个全新 iframe，绝不复用节点换血。
  const [view, setView] = useState<{ key: string; doc: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingExternal, setPendingExternal] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const prevRel = useRef(rel);
  const openFile = useApp((s) => s.openFile);
  const changed = useApp((s) => s.changed);
  const reloadTick = changed?.paths.includes(rel) ? changed.ts : 0;

  useEffect(() => {
    let dead = false;
    setPendingExternal(null);
    if (prevRel.current !== rel) {
      prevRel.current = rel;
      setView(null); // 换文件：先回载入态，不让旧文档在新 tab 下多停留
    }
    backend
      .readText(rel, FULL_CAP)
      .then((r) => {
        if (dead) return;
        setView({
          key: `${rel}:${Date.now()}`,
          doc: buildSrcdoc(r.content, backend.fileUrl(parentOf(rel)) + "/"),
        });
        setError(null);
      })
      .catch((e) => {
        if (!dead) setError(String(e));
      });
    return () => {
      dead = true;
    };
  }, [rel, reloadTick]);

  // 沙箱内点击的非锚点链接 → 宿主路由（来源必须是本视图的 iframe）
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const href = (e.data as { __openfile_link?: unknown } | null)?.__openfile_link;
      if (typeof href !== "string" || !href) return;
      if (isExternalUrl(href)) {
        // The report can post this message without a real click. Only a trusted
        // host button opens the browser; a later message cannot swap the URL
        // while the user is reviewing it. LINK_TAP_JS bytes stay unchanged.
        setPendingExternal((current) => current ?? href);
        return;
      }
      const clean = href.split(/[?#]/)[0];
      if (!clean) return;
      let decoded = clean;
      try {
        decoded = decodeURI(clean);
      } catch {
        /* 原样 */
      }
      const resolved = resolveRel(rel, decoded);
      if (resolved) openFile(resolved);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [rel, openFile]);

  if (error)
    return (
      <p className="px-8 py-10 font-sans text-[14px] text-accent-warm">{error}</p>
    );
  if (view === null)
    return <p className="px-8 py-10 font-sans text-[13.5px] text-muted">{t("正在载入…")}</p>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-rule bg-card px-3 py-1.5 font-sans text-[13px] text-muted">
        <span className="flex-1">{t("转成 Markdown 审阅稿后可以直接改、批注，agent 按稿子改回 HTML，原文件不动。")}</span>
        <button className="btn btn-outline !py-0.5 !text-[13px]" onClick={() => void reviewHtml(rel)}>
          {t("审阅修改")}
        </button>
      </div>
      {pendingExternal && (
        <section aria-label={t("打开外部链接")} className="shrink-0 border-b border-rule bg-panel px-6 py-4">
          <p className="font-sans text-[13.5px] text-muted">
            {t("文档请求打开外部链接。确认后将交给系统浏览器。")}
          </p>
          <p className="mt-2 max-h-24 overflow-y-auto break-all font-sans text-[13.5px] text-ink">{pendingExternal}</p>
          <div className="mt-3 flex gap-2">
            <button className="btn btn-primary" onClick={() => {
              const href = pendingExternal;
              setPendingExternal(null);
              void openExternal(href);
            }}>{t("打开外部链接")}</button>
            <button className="btn btn-outline" onClick={() => setPendingExternal(null)}>{t("取消")}</button>
          </div>
        </section>
      )}
      <iframe
        key={view.key}
        ref={frameRef}
        srcDoc={view.doc}
        title={rel}
        sandbox="allow-scripts"
        className="min-h-0 w-full flex-1 border-0 bg-card"
      />
    </div>
  );
}
