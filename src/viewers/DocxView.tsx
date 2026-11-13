/**
 * docx：docx-preview 0.4.1 高保真渲染（版式、表格、图片、页眉页脚、脚注），只读。
 * - 信任边界：不渲染 altChunk（库会把文档里嵌的 HTML 放进无沙箱的 srcdoc iframe）；渲染结果原地过 DOMPurify；
 *   图片用 data: URL（DOMPurify 不放行 blob:），不加载文档内嵌字体。链接一律拦下：http(s) 交给系统浏览器，
 *   文档内书签就地滚动，其余不响应。docx 生成的样式表挂在视图里，随视图卸载。
 * - 本轮改动：本轮改过这份 docx、且这一轮已结束时，按段落标出（契约见 lib/docx-changes.ts），顶部可
 *   「整份撤回」到轮前（agent-controller.undoTurnFile，规矩同整轮撤回）。逐段撤回写不回 docx，不做。
 */
import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type { Options } from "docx-preview";
import { backend } from "../lib/backend";
import { openExternal } from "../lib/external";
import { touchedInTurn } from "../lib/turn-changes";
import { undoTurnFile } from "../lib/agent-controller";
import { useAgent } from "../state/agent";
import { useApp } from "../state/store";
import { reviewDocx } from "../lib/file-actions";
import { t } from "../i18n";

const OPTIONS: Partial<Options> = {
  className: "docx",
  inWrapper: true,
  breakPages: true,
  ignoreFonts: true,
  useBase64URL: true,
  renderAltChunks: false,
  // 修订与批注照 Word 显示（导出的修订稿要看得见改了什么）
  renderChanges: true,
  renderComments: true,
};

/** 标出的段落 */
const CHANGED = "docx-turn-changed";

/** 点过「保留」的「轮后快照 + 文档」：本轮的标记不再显示（下一轮重新算） */
const kept = new Set<string>();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function DocxView({ rel }: { rel: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const changed = useApp((s) => s.changed);
  const reloadTick = changed?.paths.includes(rel) ? changed.ts : 0;

  // 文件变了就重渲：旧内容留到新的渲好再换，不闪
  useEffect(() => {
    let dead = false;
    setError(null);
    (async () => {
      const { b64 } = await backend.readBinaryB64(rel);
      const docx = await import("docx-preview");
      const body = document.createElement("div");
      const styles = document.createElement("div");
      await docx.renderAsync(b64ToBytes(b64), body, styles, OPTIONS);
      if (dead || !hostRef.current) return;
      DOMPurify.sanitize(body, { IN_PLACE: true });
      hostRef.current.replaceChildren(styles, body);
      setReady((n) => n + 1);
    })().catch((e) => {
      if (dead) return;
      hostRef.current?.replaceChildren();
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      dead = true;
    };
  }, [rel, reloadTick]);

  // 纸比视图宽就整页等比缩小（会话面板开着时查看区放不下 A4），最小 0.5，再窄就横向滚动
  useEffect(() => {
    const host = hostRef.current;
    if (!host || ready === 0) return;
    const fit = () => {
      const wrapper = host.querySelector<HTMLElement>(".docx-wrapper");
      const pages = Array.from(host.querySelectorAll<HTMLElement>("section.docx"));
      if (!wrapper || !pages.length) return;
      wrapper.style.zoom = "";
      const widest = Math.max(...pages.map((p) => p.offsetWidth));
      const room = host.clientWidth - 32;
      wrapper.style.zoom = widest > room ? String(Math.max(0.5, room / widest)) : "";
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [ready]);

  // 链接：文档里的 href 来自 docx 关系表，不让它在应用窗口里导航
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest("a") : null;
      if (!a || !host.contains(a)) return;
      e.preventDefault();
      let url: URL;
      try {
        url = new URL(a.getAttribute("href") ?? "", window.location.href);
      } catch {
        return;
      }
      // 书签链接被库写成「当前页地址 + #书签名」
      if (url.origin === window.location.origin) {
        const id = decodeURIComponent(url.hash.slice(1));
        if (id) host.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
        return;
      }
      if (url.protocol === "http:" || url.protocol === "https:") void openExternal(url.href);
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, []);

  return (
    <div className="min-h-full bg-panel">
      {!error && (
        <div className="flex items-center justify-end gap-2 border-b border-rule bg-card px-3 py-1.5 font-sans text-[13px] text-muted">
          <span className="flex-1">{t("在审阅模式里改，改完导出成带 Word 修订的副本，原件不动。")}</span>
          <button className="btn btn-outline !py-0.5 !text-[13px]" onClick={() => void reviewDocx(rel)}>
            {t("审阅修改")}
          </button>
        </div>
      )}
      {error ? (
        <p className="px-8 py-10 font-sans text-[14px] text-accent-warm">
          {t("无法解析该 docx：")}{error}
        </p>
      ) : (
        <>
          {ready === 0 && <p className="px-8 py-10 font-sans text-[13.5px] text-muted">{t("正在解析 docx…")}</p>}
          {ready > 0 && <TurnBanner rel={rel} host={hostRef} ready={ready} />}
        </>
      )}
      {/* 子节点由 docx-preview 生成、整块替换，React 不管它的内容；选区引用只认这一块（document-context.ts） */}
      <div ref={hostRef} className="docx-doc" />
    </div>
  );
}

/** 本轮改动：段落标记 + 顶部横幅（保留 / 整份撤回） */
function TurnBanner({ rel, host, ready }: { rel: string; host: React.RefObject<HTMLDivElement | null>; ready: number }) {
  const tc = useAgent((s) => s.turnChanges);
  const running = useAgent((s) => s.status === "running");
  const undoing = useAgent((s) => s.turnUndoing);
  const root = useApp((s) => s.lib?.root);
  const touched = touchedInTurn(tc, root, rel);
  const key = tc ? `${tc.headId}:${rel}` : "";
  const [hunks, setHunks] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [, rerender] = useState(0);
  const show = !!tc && !!touched && !running && !kept.has(key);

  useEffect(() => {
    const el = host.current;
    setHunks(null);
    setNote(null);
    if (!el || !tc || !show || touched?.status !== "modified") return;
    let dead = false;
    (async () => {
      const base = await backend.readSnapshotB64(tc.baseId, rel);
      if (!base) return;
      const [docx, { changedParagraphs, DOCX_PARAGRAPHS }] = await Promise.all([import("docx-preview"), import("../lib/docx-changes")]);
      // 轮前那份渲在不挂进页面的节点里，只取段落文字
      const holder = document.createElement("div");
      holder.append(...(await docx.renderDocument(await docx.parseAsync(b64ToBytes(base.b64), OPTIONS), OPTIONS)));
      const before = Array.from(holder.querySelectorAll(DOCX_PARAGRAPHS), (p) => p.textContent ?? "");
      const now = Array.from(el.querySelectorAll(DOCX_PARAGRAPHS));
      const { marked, hunks } = changedParagraphs(before, now.map((p) => p.textContent ?? ""));
      if (dead) return;
      for (const i of marked) now[i].classList.add(CHANGED);
      setHunks(hunks);
    })().catch(() => {});
    return () => {
      dead = true;
      for (const p of el.querySelectorAll(`.${CHANGED}`)) p.classList.remove(CHANGED);
    };
  }, [host, ready, tc, show, touched?.status, rel]);

  if (!show || !tc || !touched) return null;
  const message =
    touched.status === "added"
      ? t("第 {0} 轮新建了这份文档", [tc.turn])
      : hunks === null
        ? t("第 {0} 轮改了这份文档", [tc.turn])
        : hunks === 0
          ? t("第 {0} 轮改了这份文档，段落文字没变（可能只改了格式）", [tc.turn])
          : t("第 {0} 轮在这份文档里改了 {1} 处", [tc.turn, hunks]);
  const undo = async () => {
    const result = await undoTurnFile(rel);
    // 撤成了：文件变了会重新渲染、横幅随本轮改动一起消失；没撤成就把原因留在这里
    if (result && useAgent.getState().turnChanges?.files.some((f) => f.path === rel)) setNote(result);
  };
  return (
    <div className="sticky top-0 z-10 border-b border-rule bg-card px-3 py-1.5 font-sans text-[13px] text-ink">
      <div className="flex items-center gap-2">
        <span className="flex-1">{message}</span>
        <button
          className="btn btn-outline !py-0.5 !text-[13px]"
          onClick={() => {
            kept.add(key);
            rerender((n) => n + 1);
          }}
        >
          {t("保留")}
        </button>
        <button
          className="btn btn-primary !py-0.5 !text-[13px]"
          disabled={undoing}
          title={t("docx 不能逐段撤回，只能整份回到第 {0} 轮之前", [tc.turn])}
          onClick={() => void undo()}
        >
          {t("整份撤回")}
        </button>
      </div>
      {note && <p className="mt-1 text-accent-warm">{note}</p>}
    </div>
  );
}
