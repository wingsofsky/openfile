/**
 * 文件树的右键菜单、属性面板与提示。动作全部在 src/lib/file-actions.ts。
 * 菜单是 fixed 定位的普通 DOM（不走系统原生菜单：dev / 桌面 / 三平台同一份行为）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { backend } from "../lib/backend";
import { copyPath, newFolder, newMarkdown, paste, reveal, setClipboard, targetsOf, trash } from "../lib/file-actions";
import type { EntryInfo } from "../lib/types";
import { MOD, baseName, formatBytes, parentOf, viewerKindOf } from "../lib/util";
import { useFiles } from "../state/files";
import { useApp } from "../state/store";
import { t } from "../i18n";

const IS_MAC = MOD === "⌘";

interface Item {
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  run(): void;
}

function TreeMenu() {
  const menu = useFiles((s) => s.menu)!;
  const clipboard = useFiles((s) => s.clipboard);
  const close = useFiles((s) => s.closeMenu);
  const openFile = useApp((s) => s.openFile);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  // 贴边时往回收，别出视口
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu.x, menu.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [close]);

  const entry = menu.entry;
  const dir = entry === null ? "" : entry.isDir ? entry.rel : parentOf(entry.rel);
  // 右键点在多选之内：菜单作用于整个选区，只留对一批文件有意义的项
  const rels = entry ? targetsOf(entry.rel) : [];
  const many = rels.length > 1;
  const groups: Item[][] = [];
  if (entry && !entry.isDir && !many) groups.push([{ label: t("打开"), run: () => openFile(entry.rel) }]);
  if (!many) {
    groups.push([
      { label: t("新建文件夹"), run: () => void newFolder(dir) },
      { label: t("新建 Markdown 文档"), run: () => void newMarkdown(dir) },
    ]);
  }
  const clip: Item[] = [];
  if (entry) {
    clip.push(
      { label: many ? t("拷贝 {0} 项", [rels.length]) : t("拷贝"), hint: `${MOD}C`, run: () => setClipboard(rels, "copy") },
      { label: many ? t("剪切 {0} 项", [rels.length]) : t("剪切"), hint: `${MOD}X`, run: () => setClipboard(rels, "cut") },
    );
  }
  if (!many) {
    const held = clipboard?.rels ?? [];
    clip.push({
      label: held.length === 1 ? t("粘贴「{0}」", [baseName(held[0])]) : held.length > 1 ? t("粘贴 {0} 项", [held.length]) : t("粘贴"),
      hint: `${MOD}V`,
      // 桌面端以系统剪贴板为准（访达里拷的也能粘），事先不知道里面有没有文件，所以不置灰
      disabled: !clipboard && !backend.transfer,
      run: () => void paste(dir),
    });
  }
  groups.push(clip);
  if (entry && !many) {
    groups.push([
      { label: t("重命名"), hint: "F2", run: () => useFiles.setState({ renaming: entry.rel }) },
      { label: t("拷贝相对路径"), run: () => void copyPath(entry.rel, false) },
      { label: t("拷贝完整路径"), run: () => void copyPath(entry.rel, true) },
    ]);
  }
  if (!many) {
    groups.push([
      { label: IS_MAC ? t("在访达中显示") : t("在文件管理器中显示"), run: () => void reveal(entry?.rel ?? "") },
      ...(entry ? [{ label: t("属性"), run: () => useFiles.setState({ infoRel: entry.rel }) }] : []),
    ]);
  }
  if (entry) {
    groups.push([{
      label: many ? t("将 {0} 项移到废纸篓", [rels.length]) : t("移到废纸篓"),
      hint: IS_MAC ? "⌘⌫" : "Del",
      danger: true,
      run: () => void trash(rels),
    }]);
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={many ? t("{0} 项的操作", [rels.length]) : entry ? t("「{0}」的操作", [entry.name]) : t("文库操作")}
      className="fixed z-50 min-w-48 rounded-[4px] border border-rule bg-card py-1 font-sans shadow-[var(--shadow-card)]"
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }}
    >
      {groups.map((group, gi) => (
        <div key={gi} className={gi > 0 ? "mt-1 border-t border-rule pt-1" : ""}>
          {group.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              disabled={item.disabled}
              className={`flex w-full items-center justify-between gap-6 px-3 py-1 text-left text-[13.5px] hover:bg-[var(--hover-surface)] focus-visible:bg-[var(--hover-surface)] disabled:text-muted disabled:hover:bg-transparent ${
                item.danger ? "text-accent-warm" : "text-ink"
              }`}
              onClick={() => {
                close();
                item.run();
              }}
            >
              <span className="truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-[12px] text-muted">{item.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 渲染时才过 t()（模块级常量会把语言钉死在首次加载时） */
function kindLabel(ext: string): string {
  switch (viewerKindOf(ext)) {
    case "markdown": return t("Markdown 文档");
    case "html": return t("HTML 文档");
    case "docx": return t("Word 文档");
    case "pdf": return t("PDF 文档");
    case "image": return t("图像");
    case "text": return t("纯文本 / 代码");
    default: return t("其它文件");
  }
}

function fmtDate(secs: number | null): string {
  if (secs === null || secs <= 0) return "—";
  return new Date(secs * 1000).toLocaleString();
}

function InfoDialog({ rel }: { rel: string }) {
  const root = useApp((s) => s.lib?.root);
  const [info, setInfo] = useState<EntryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => useFiles.setState({ infoRel: null });

  useEffect(() => {
    let dead = false;
    backend
      .entryInfo(rel, root)
      .then((i) => !dead && setInfo(i))
      .catch((e) => !dead && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      dead = true;
    };
  }, [rel, root]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useFiles.setState({ infoRel: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ext = baseName(rel).includes(".") ? baseName(rel).split(".").pop()!.toLowerCase() : "";
  const rows: Array<[string, string]> = info
    ? [
        [t("种类"), info.isSymlink ? t("符号链接") : info.isDir ? t("文件夹") : `${kindLabel(ext)}${ext ? `（.${ext}）` : ""}`],
        [t("位置"), parentOf(rel) === "" ? t("文库根目录") : parentOf(rel)],
        [t("大小"), `${formatBytes(info.size)}（${info.size.toLocaleString()} ${t("字节")}）${info.truncated ? t("，仅统计了前 20 万项") : ""}`],
        ...(info.items !== null ? [[t("包含"), t("{0} 项", [info.items.toLocaleString()])] as [string, string]] : []),
        ...(info.linkTarget !== null ? [[t("链接目标"), info.linkTarget] as [string, string]] : []),
        [t("创建时间"), fmtDate(info.created)],
        [t("修改时间"), fmtDate(info.mtime)],
        [t("权限"), info.readonly ? t("只读") : t("可读写")],
      ]
    : [];

  return (
    <div
      className="fixed inset-0 z-50 bg-[var(--overlay)]"
      role="dialog"
      aria-modal="true"
      aria-label={t("属性")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="mx-auto mt-[14vh] w-[min(440px,92vw)] overflow-hidden rounded-[4px] border border-rule bg-card font-sans shadow-[var(--shadow-card)]">
        <div className="border-b border-rule px-4 py-2.5">
          <p className="break-all text-[14.5px] font-semibold text-ink">{baseName(rel)}</p>
        </div>
        <div className="px-4 py-3">
          {error && <p className="text-[13px] text-accent-warm">{error}</p>}
          {!info && !error && <p className="text-[13px] text-muted">{t("正在统计…")}</p>}
          {info && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13.5px]">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="break-all text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-rule px-4 py-2.5">
          <button className="btn btn-outline !py-1 !text-[13px]" onClick={() => void reveal(rel)}>
            {IS_MAC ? t("在访达中显示") : t("在文件管理器中显示")}
          </button>
          <button className="btn btn-primary !py-1 !text-[13px]" autoFocus onClick={close}>
            {t("好")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TreeMenuLayer() {
  const menu = useFiles((s) => s.menu);
  const infoRel = useFiles((s) => s.infoRel);
  return (
    <>
      {menu && <TreeMenu key={`${menu.x}:${menu.y}:${menu.entry?.rel ?? ""}`} />}
      {infoRel !== null && <InfoDialog key={infoRel} rel={infoRel} />}
    </>
  );
}

/** 文库栏底部的一行提示（操作结果 / 失败原因），6 秒后自行消失 */
export function TreeNotice() {
  const notice = useFiles((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => {
      if (useFiles.getState().notice?.ts === notice.ts) useFiles.setState({ notice: null });
    }, 6000);
    return () => clearTimeout(id);
  }, [notice]);
  if (!notice) return null;
  return (
    <p
      role="status"
      className={`shrink-0 border-t border-rule px-3 py-1.5 font-sans text-[12.5px] leading-snug ${
        notice.tone === "error" ? "text-accent-warm" : "text-muted"
      }`}
    >
      {notice.text}
    </p>
  );
}
