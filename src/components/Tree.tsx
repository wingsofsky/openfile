import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  CaretRight,
  File,
  FileCode,
  FileDoc,
  FileHtml,
  FileImage,
  FileMd,
  FilePdf,
  FileText,
  Folder,
  FolderOpen,
} from "@phosphor-icons/react";
import { backend } from "../lib/backend";
import type { Entry } from "../lib/types";
import { naturalCompare, parentOf, viewerKindOf } from "../lib/util";
import { useApp } from "../state/store";
import { useFiles } from "../state/files";
import { copyInto, importDropped, moveInto, paste, rename, setClipboard, startDragOut, targetsOf, trash } from "../lib/file-actions";
import { TreeMenuLayer } from "./TreeMenu";
import { t } from "../i18n";

const RENDER_CAP = 400;

function FileIcon({ ext }: { ext: string }) {
  const cls = "shrink-0 text-muted";
  const size = 15;
  switch (viewerKindOf(ext)) {
    case "markdown":
      return <FileMd size={size} className={cls} aria-hidden />;
    case "html":
      return <FileHtml size={size} className={cls} aria-hidden />;
    case "docx":
      return <FileDoc size={size} className={cls} aria-hidden />;
    case "pdf":
      return <FilePdf size={size} className={cls} aria-hidden />;
    case "image":
      return <FileImage size={size} className={cls} aria-hidden />;
    case "text":
      return ext === "txt" || ext === "log" ? (
        <FileText size={size} className={cls} aria-hidden />
      ) : (
        <FileCode size={size} className={cls} aria-hidden />
      );
    default:
      return <File size={size} className={cls} aria-hidden />;
  }
}

function useDirEntries(rel: string, open: boolean) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = useApp((s) => s.changed);

  const load = useCallback(() => {
    backend
      .listDir(rel)
      .then((es) => {
        es.sort(
          (a, b) => Number(b.isDir) - Number(a.isDir) || naturalCompare(a.name, b.name),
        );
        setEntries(es);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [rel]);

  useEffect(() => {
    if (open && entries === null) load();
  }, [open, entries, load]);

  // 变更事件：只有当变化发生在本目录的直接子级时刷新
  useEffect(() => {
    if (!open || !changed) return;
    if (changed.paths.some((p) => parentOf(p) === rel || p === rel)) load();
  }, [changed, open, rel, load]);

  return { entries, error, reload: load };
}

const Row = memo(function Row({
  entry,
  depth,
}: {
  entry: Entry;
  depth: number;
}) {
  if (entry.isDir) return <DirRow entry={entry} depth={depth} />;
  return <FileRow entry={entry} depth={depth} />;
});

const DRAG_TYPE = "application/x-openfile-rel";

/** 当前树里可见的行，按显示顺序（Shift 连选 / 全选用） */
function visibleRels(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("nav [data-rel]")).map((el) => el.dataset.rel!);
}

/**
 * 点击的选择语义（访达同款）：MOD+点 = 增减一项；Shift+点 = 从上次点的那行连选到这行；
 * 普通点 = 只选这一行。返回 true 表示这次点击只是在改选区，不要再触发打开 / 展开。
 */
function selectOnClick(e: React.MouseEvent, rel: string): boolean {
  const { selected, anchor } = useFiles.getState();
  if (e.metaKey || e.ctrlKey) {
    useFiles.setState({
      selected: selected.includes(rel) ? selected.filter((r) => r !== rel) : [...selected, rel],
      anchor: rel,
    });
    return true;
  }
  if (e.shiftKey && anchor !== null) {
    const rows = visibleRels();
    const [i, j] = [rows.indexOf(anchor), rows.indexOf(rel)];
    if (i !== -1 && j !== -1) {
      useFiles.setState({ selected: rows.slice(Math.min(i, j), Math.max(i, j) + 1) });
      return true;
    }
  }
  useFiles.setState({ selected: [rel], anchor: rel });
  return false;
}

/** 行上的管理手势：右键菜单、拖起、键盘（F2 / MOD+A·C·X·V / MOD+⌫·Delete / Esc）；多选时作用于整个选区 */
function useRowGestures(entry: Entry) {
  const cut = useFiles((s) => s.clipboard?.mode === "cut" && s.clipboard.rels.includes(entry.rel));
  const selected = useFiles((s) => s.selected.includes(entry.rel));
  const pasteDir = entry.isDir ? entry.rel : parentOf(entry.rel);
  return {
    cut,
    selected,
    props: {
      "data-rel": entry.rel,
      "aria-selected": selected,
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        const rels = targetsOf(entry.rel);
        if (backend.transfer) {
          // 桌面端：换成系统原生拖动——同一个手势既能丢到树里别的文件夹，也能丢出窗口
          e.preventDefault();
          startDragOut(rels);
          return;
        }
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(rels));
        e.dataTransfer.effectAllowed = "copyMove";
      },
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // 右键点在选区之外：选区换成这一行（访达同款）
        if (!useFiles.getState().selected.includes(entry.rel)) useFiles.setState({ selected: [entry.rel], anchor: entry.rel });
        useFiles.getState().openMenu({ x: e.clientX, y: e.clientY, entry });
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.nativeEvent.isComposing) return;
        const mod = e.metaKey || e.ctrlKey;
        const key = e.key.toLowerCase();
        const rels = targetsOf(entry.rel);
        if (e.key === "F2" && rels.length === 1) useFiles.setState({ renaming: entry.rel });
        else if (mod && key === "a") useFiles.setState({ selected: visibleRels(), anchor: entry.rel });
        else if (mod && key === "c") setClipboard(rels, "copy");
        else if (mod && key === "x") setClipboard(rels, "cut");
        else if (mod && key === "v") void paste(pasteDir);
        else if ((mod && e.key === "Backspace") || e.key === "Delete") void trash(rels);
        else if (e.key === "Escape" && useFiles.getState().selected.length > 0) useFiles.setState({ selected: [], anchor: null });
        else return;
        e.preventDefault();
        e.stopPropagation();
      },
    },
  };
}

/** 目录（或根）作为拖放目标：默认移动，按住 Alt/Option 为复制 */
function useDropTarget(dir: string) {
  const over = useFiles((s) => s.dropTarget === dir);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
        if (useFiles.getState().dropTarget !== dir) useFiles.setState({ dropTarget: dir });
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (useFiles.getState().dropTarget === dir) useFiles.setState({ dropTarget: null });
      },
      onDrop: (e: React.DragEvent) => {
        const raw = e.dataTransfer.getData(DRAG_TYPE);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        useFiles.setState({ dropTarget: null });
        let rels: string[] = [];
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) rels = parsed.filter((r): r is string => typeof r === "string");
        } catch {
          return;
        }
        void (e.altKey ? copyInto(rels, dir) : moveInto(rels, dir));
      },
    },
  };
}

/** 行内重命名：原生 input，组合态回车是选字不是提交；聚焦时只选中主名 */
function RenameInput({ entry }: { entry: Entry }) {
  const [value, setValue] = useState(entry.name);
  const done = useRef(false);
  const commit = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    if (v === null) useFiles.setState({ renaming: null });
    else void rename(entry.rel, v.trim());
  };
  return (
    <input
      className="min-w-0 flex-1 rounded-[2px] border border-rule bg-card px-1 text-[14px] leading-[1.4] text-ink"
      aria-label={t("新名称")}
      value={value}
      autoFocus
      onFocus={(e) => {
        const dot = entry.isDir ? -1 : entry.name.lastIndexOf(".");
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
      }}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") commit(value);
        if (e.key === "Escape") commit(null);
      }}
      onBlur={() => commit(value)}
    />
  );
}

function FileRow({ entry, depth }: { entry: Entry; depth: number }) {
  const openFile = useApp((s) => s.openFile);
  const active = useApp((s) => s.activeId === entry.rel);
  const renaming = useFiles((s) => s.renaming === entry.rel);
  const { cut, selected, props } = useRowGestures(entry);
  if (renaming)
    return (
      <div className="flex w-full items-center gap-1.5 px-1.5 py-[2px]" style={{ paddingLeft: depth * 14 + 22 }}>
        <FileIcon ext={entry.ext} />
        <RenameInput entry={entry} />
      </div>
    );
  return (
    <button
      className={`flex w-full items-center gap-1.5 rounded-[3px] px-1.5 py-[3px] text-left text-[14px] leading-[1.4] ${
        active || selected ? "bg-[var(--active-surface)] text-ink" : "text-ink hover:bg-[var(--hover-surface)]"
      } ${cut ? "opacity-50" : ""}`}
      style={{ paddingLeft: depth * 14 + 22 }}
      onClick={(e) => {
        if (!selectOnClick(e, entry.rel)) openFile(entry.rel);
      }}
      title={entry.rel}
      {...props}
    >
      <FileIcon ext={entry.ext} />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

function DirRow({ entry, depth }: { entry: Entry; depth: number }) {
  const [open, setOpen] = useState(false);
  const renaming = useFiles((s) => s.renaming === entry.rel);
  const expand = useFiles((s) => s.expand);
  const { cut, selected, props } = useRowGestures(entry);
  const drop = useDropTarget(entry.rel);
  // 新建 / 粘贴 / 拖入到本目录（或其子孙）之后：展开，让结果看得见
  useEffect(() => {
    if (expand && (expand.rel === entry.rel || expand.rel.startsWith(entry.rel + "/"))) setOpen(true);
  }, [expand, entry.rel]);
  return (
    <div {...drop.props} data-drop-dir={entry.rel} className={drop.over ? "rounded-[3px] bg-[var(--hover-surface)]" : ""}>
      {renaming ? (
        <div className="flex w-full items-center gap-1 px-1.5 py-[2px]" style={{ paddingLeft: depth * 14 + 19 }}>
          <Folder size={15} className="shrink-0 text-muted" aria-hidden />
          <RenameInput entry={entry} />
        </div>
      ) : (
        <button
          className={`flex w-full items-center gap-1 rounded-[3px] px-1.5 py-[3px] text-left text-[14px] leading-[1.4] text-ink ${
            selected ? "bg-[var(--active-surface)]" : "hover:bg-[var(--hover-surface)]"
          } ${cut ? "opacity-50" : ""}`}
          style={{ paddingLeft: depth * 14 + 4 }}
          onClick={(e) => {
            if (!selectOnClick(e, entry.rel)) setOpen(!open);
          }}
          aria-expanded={open}
          title={entry.rel}
          {...props}
        >
          <CaretRight
            size={11}
            className={`shrink-0 text-muted transition-transform duration-[var(--duration-base)] ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
          {open ? (
            <FolderOpen size={15} className="shrink-0 text-muted" aria-hidden />
          ) : (
            <Folder size={15} className="shrink-0 text-muted" aria-hidden />
          )}
          <span className="truncate font-medium">{entry.name}</span>
        </button>
      )}
      {open && <DirChildren rel={entry.rel} depth={depth + 1} open={open} />}
    </div>
  );
}

function DirChildren({
  rel,
  depth,
  open,
}: {
  rel: string;
  depth: number;
  open: boolean;
}) {
  const { entries, error } = useDirEntries(rel, open);
  const [cap, setCap] = useState(RENDER_CAP);
  if (error)
    return (
      <p className="px-4 py-1 text-[13px] text-accent-warm" style={{ paddingLeft: depth * 14 + 22 }}>
        {error}
      </p>
    );
  if (!entries)
    return (
      <p className="px-4 py-1 text-[13px] text-muted" style={{ paddingLeft: depth * 14 + 22 }}>
        …
      </p>
    );
  const shown = entries.slice(0, cap);
  return (
    <div role="group">
      {shown.map((e) => (
        <Row key={e.rel} entry={e} depth={depth} />
      ))}
      {entries.length > cap && (
        <button
          className="w-full px-1.5 py-1 text-left text-[13px] text-accent-cool hover:bg-[var(--hover-surface)]"
          style={{ paddingLeft: depth * 14 + 22 }}
          onClick={() => setCap(cap + RENDER_CAP)}
        >
          {t("显示其余")}{" "}{entries.length - cap} {t("项…")}
        </button>
      )}
    </div>
  );
}

/** 系统拖放（桌面端）：按指针位置找它底下最近的目录行；落在树外不管 */
function useSystemDrops() {
  useEffect(() => {
    if (!backend.transfer) return;
    const dirAt = (x: number, y: number): string | null =>
      document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-dir]")?.dataset.dropDir ?? null;
    return backend.transfer.onDragDrop((e) => {
      if (e.type === "leave") return useFiles.setState({ dropTarget: null });
      const dir = dirAt(e.x, e.y);
      if (e.type === "over") {
        if (useFiles.getState().dropTarget !== dir) useFiles.setState({ dropTarget: dir });
        return;
      }
      useFiles.setState({ dropTarget: null });
      if (dir !== null) void importDropped(dir);
    });
  }, []);
}

export function Tree() {
  const drop = useDropTarget("");
  useSystemDrops();
  return (
    <nav
      data-drop-dir=""
      aria-label={t("文库文件树")}
      className={`min-h-full px-1.5 pb-6 ${drop.over ? "bg-[var(--hover-surface)]" : ""}`}
      {...drop.props}
      onClick={(e) => {
        if (e.target === e.currentTarget) useFiles.setState({ selected: [], anchor: null });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        useFiles.setState({ selected: [], anchor: null });
        useFiles.getState().openMenu({ x: e.clientX, y: e.clientY, entry: null });
      }}
    >
      <DirChildren rel="" depth={0} open />
      <TreeMenuLayer />
    </nav>
  );
}
