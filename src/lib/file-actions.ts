/**
 * 文件管理动作：文件树的菜单 / 快捷键 / 拖放共用这一份。
 * 每个动作都钉住发起时的文库根（expectedRoot）；成功后推一条合成变更让树立刻刷新
 * （监听器事件稍后也会到，幂等），并让已打开的 tab 跟着新路径走。
 */
import { backend, libraryAbsPath } from "./backend";
import { baseName, parentOf } from "./util";
import { useApp } from "../state/store";
import { useFiles } from "../state/files";
import type { ImportReport } from "./types";
import { t } from "../i18n";

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(msg) as { error?: unknown };
    if (typeof j.error === "string") return j.error;
  } catch {
    /* 不是 JSON */
  }
  return msg;
}

function touched(...rels: string[]) {
  useApp.setState({ changed: { paths: rels, ts: Date.now() } });
}

async function run<T>(label: string, fn: (root: string) => Promise<T>): Promise<T | null> {
  const root = useApp.getState().lib?.root;
  if (!root) return null;
  try {
    return await fn(root);
  } catch (e) {
    useFiles.getState().say(`${label}：${errText(e)}`, "error");
    return null;
  }
}

const expand = (rel: string) => {
  if (rel !== "") useFiles.setState({ expand: { rel, ts: Date.now() } });
};

/** 撞名就往后编号（「未命名文件夹 2」），最多试 50 个 */
async function withFreeName<T>(stem: string, ext: string, make: (name: string) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let n = 1; n <= 50; n++) {
    try {
      return await make(n === 1 ? `${stem}${ext}` : `${stem} ${n}${ext}`);
    } catch (e) {
      last = e;
      if (!/已存在/.test(errText(e))) throw e;
    }
  }
  throw last;
}

export async function newFolder(dir: string) {
  const rel = await run(t("新建文件夹失败"), (root) =>
    withFreeName(t("未命名文件夹"), "", (name) => backend.createDir(dir, name, root)));
  if (rel === null) return;
  expand(dir);
  touched(rel);
  useFiles.setState({ renaming: rel });
}

export async function newMarkdown(dir: string) {
  const rel = await run(t("新建文档失败"), (root) =>
    withFreeName(t("未命名"), ".md", async (name) => {
      const target = dir === "" ? name : `${dir}/${name}`;
      await backend.writeText(target, "", root, null); // null 基线 = 只新建、不覆盖
      return target;
    }));
  if (rel === null) return;
  expand(dir);
  touched(rel);
  useFiles.setState({ renaming: rel });
}

export async function rename(rel: string, name: string) {
  useFiles.setState({ renaming: null });
  if (name === baseName(rel) || name.trim() === "") return;
  const next = await run(t("重命名失败"), (root) => backend.renameEntry(rel, name, root));
  if (next === null) return;
  useApp.getState().retargetTabs(rel, next);
  touched(rel, next);
}

/** 去掉「祖先也在列」的项：选了文件夹又选了它里面的文件，只操作文件夹 */
export function topLevel(rels: string[]): string[] {
  const uniq = [...new Set(rels)];
  return uniq.filter((r) => !uniq.some((o) => o !== r && r.startsWith(o + "/")));
}

/** 一个手势作用于谁：行在多选之内 → 整个选区；否则只有这一行 */
export function targetsOf(rel: string): string[] {
  const { selected } = useFiles.getState();
  return selected.length > 1 && selected.includes(rel) ? topLevel(selected) : [rel];
}

export async function moveInto(rels: string[], dir: string) {
  for (const rel of topLevel(rels)) {
    if (parentOf(rel) === dir || rel === dir) continue;
    const next = await run(t("移动失败"), (root) => backend.moveEntry(rel, dir, root));
    if (next === null) break; // 第一处失败就停，别让一串同因错误刷掉提示
    if (next === rel) continue;
    useApp.getState().retargetTabs(rel, next);
    touched(rel, next);
  }
  expand(dir);
  useFiles.setState({ selected: [], anchor: null });
}

export async function copyInto(rels: string[], dir: string) {
  for (const rel of topLevel(rels)) {
    const next = await run(t("复制失败"), (root) => backend.copyEntry(rel, dir, root));
    if (next === null) break;
    touched(next);
  }
  expand(dir);
}

/** 拷贝 / 剪切到应用内剪贴板；桌面端的「拷贝」同时把文件放上系统剪贴板，可去别的 app / 网页里粘贴 */
export function setClipboard(rels: string[], mode: "copy" | "cut") {
  const list = topLevel(rels);
  useFiles.setState({ clipboard: { rels: list, mode } });
  if (mode !== "copy" || !backend.transfer) return;
  void run(t("无法写入系统剪贴板"), (root) => backend.transfer!.copyFilesToClipboard(list, root)).then((r) => {
    if (r !== null) useFiles.getState().say(list.length === 1
      ? t("已拷贝，可粘贴到其它应用：{0}", [baseName(list[0])])
      : t("已拷贝 {0} 项，可粘贴到其它应用", [list.length]));
  });
}

/** 系统来的一批文件落地之后：tab 跟随、树刷新、报告结果 */
function applyImport(report: ImportReport, dir: string) {
  for (const [from, to] of report.moved) useApp.getState().retargetTabs(from, to);
  expand(dir);
  touched(...report.imported, ...report.moved.flat());
  if (report.moved.length > 0) useFiles.setState({ selected: [], anchor: null });
  const done = report.imported.length + report.moved.length;
  if (report.skipped.length > 0) {
    const [name, why] = report.skipped[0];
    useFiles.getState().say(t("{0} 项完成，{1} 项跳过（{2}：{3}）", [done, report.skipped.length, name, why]), "error");
  } else if (report.imported.length > 0) {
    useFiles.getState().say(t("已放入 {0} 项", [report.imported.length]));
  }
}

/** 系统拖放落到树上（桌面端）：源路径在 Rust 侧暂存，这里只说放进哪个目录。树上拖入是复制进文库，不是「以 Openfile 打开」，提示里说清 */
export async function importDropped(dir: string) {
  const report = await run(t("放入失败"), (root) => backend.transfer!.importDropped(dir, root));
  if (!report) return;
  applyImport(report, dir);
  if (report.skipped.length === 0 && report.imported.length > 0) {
    useFiles.getState().say(t("已复制 {0} 项进文库。要原地打开，用系统的「打开方式」选 Openfile", [report.imported.length]));
  }
}

export async function paste(dir: string) {
  const clip = useFiles.getState().clipboard;
  if (clip?.mode === "cut") {
    useFiles.setState({ clipboard: null });
    await moveInto(clip.rels, dir);
    return;
  }
  if (backend.transfer) {
    // 桌面端以系统剪贴板为准：访达里拷的、本应用里拷的，都在那儿
    const report = await run(t("粘贴失败"), (root) => backend.transfer!.pasteClipboardFiles(dir, root));
    if (report) applyImport(report, dir);
    return;
  }
  if (clip) await copyInto(clip.rels, dir);
}

/** 从树上拖起（桌面端）：交给系统做原生拖动，可丢进网页上传框 / 别的 app / 访达 */
export function startDragOut(rels: string[]) {
  void run(t("无法开始拖动"), (root) => backend.transfer!.startDragOut(topLevel(rels), root));
}

export async function trash(rels: string[]) {
  const list = topLevel(rels);
  const gone: string[] = [];
  for (const rel of list) {
    const ok = await run(t("移到废纸篓失败"), async (root) => {
      await backend.trashEntry(rel, root);
      return true;
    });
    if (!ok) break;
    gone.push(rel);
    useApp.getState().closeTabsUnder(rel);
  }
  if (gone.length === 0) return;
  const under = (r: string) => gone.some((g) => r === g || r.startsWith(g + "/"));
  const files = useFiles.getState();
  useFiles.setState({
    clipboard: files.clipboard?.rels.some(under) ? null : files.clipboard,
    selected: files.selected.filter((r) => !under(r)),
  });
  touched(...gone);
  if (gone.length === list.length) {
    files.say(gone.length === 1 ? t("已移到废纸篓：{0}", [baseName(gone[0])]) : t("已将 {0} 项移到废纸篓", [gone.length]));
  }
}

export async function reveal(rel: string) {
  await run(t("无法在文件管理器中显示"), (root) => backend.revealEntry(rel, root));
}

export async function copyPath(rel: string, absolute: boolean) {
  const root = useApp.getState().lib?.root;
  const text = absolute && root ? (rel === "" ? root : `${root}/${rel}`) : rel;
  try {
    await navigator.clipboard.writeText(text);
    useFiles.getState().say(t("路径已复制"));
  } catch {
    useFiles.getState().say(t("无法写入系统剪贴板"), "error");
  }
}

/**
 * 交给 agent 的预设提示词：带文件在磁盘上的精确绝对路径，复制进剪贴板，贴进 agent 的对话框。
 * 跟随界面语言：英文界面复制英文提示词（agent 用什么语言回答，多半跟着提示词走）。
 */
export function reviewPrompt(root: string, rel: string): string {
  return t("看一下 {0} 我的批注，回答问题并应用改动", [libraryAbsPath(root, rel)]);
}

export async function copyReviewPrompt(rel: string): Promise<boolean> {
  const root = useApp.getState().lib?.root;
  if (!root) return false;
  try {
    await navigator.clipboard.writeText(reviewPrompt(root, rel));
    return true;
  } catch {
    useFiles.getState().say(t("无法写入系统剪贴板"), "error");
    return false;
  }
}

/* ---- Word 往返：docx → 审阅稿（Markdown + 修订）→ 带原生修订的 docx 副本 ---- */

/** 打开 docx 的审阅稿（没有就建一份），在审阅模式里改 */
export async function reviewDocx(rel: string) {
  const r = await run(t("无法建立审阅稿"), (root) => backend.importDocx(rel, root));
  if (!r) return;
  if (r.created) touched(r.rel);
  useApp.getState().openFile(r.rel);
  if (r.hadMarkup) useFiles.getState().say(t("原文件里已有修订或批注：审阅稿里是接受修订后的正文，原有批注不带过来。"));
}

/** 审阅稿导出成 Word 修订稿（不覆盖原件），导出后打开它 */
export async function exportDocxReview(reviewRel: string) {
  const r = await run(t("无法导出 Word 修订稿"), (root) => backend.exportDocx(reviewRel, root));
  if (!r) return;
  touched(r.rel);
  useFiles.getState().say(t("已导出 {0}（{1} 处修订与批注）", [baseName(r.rel), r.applied]));
  useApp.getState().openFile(r.rel);
}

/* ---- 文献 PDF → Markdown 笔记：本机 Docling 转换，笔记放在 PDF 旁边，在审阅模式里高亮、批注 ---- */

/** 打开 PDF 的笔记（没有就转一份）；转换要几秒到几分钟（首次会下载模型） */
export async function pdfNotes(rel: string) {
  const r = await run(t("无法转成 Markdown"), (root) => backend.pdfToMarkdown(rel, root));
  if (!r) return;
  if (r.created) {
    touched(r.rel);
    useFiles.getState().say(t("已转成 {0}（{1} 页）", [baseName(r.rel), r.pages]));
  }
  useApp.getState().openFile(r.rel);
}

/* ---- HTML → Markdown 审阅稿：在审阅模式里改、批注，agent 按稿子改回 HTML；原 HTML 不动 ---- */

/** 打开 HTML 的审阅稿（没有就转一份） */
export async function reviewHtml(rel: string) {
  const r = await run(t("无法建立审阅稿"), (root) => backend.htmlToReview(rel, root));
  if (!r) return;
  if (r.created) touched(r.rel);
  useApp.getState().openFile(r.rel);
  if (r.stale) useFiles.getState().say(t("HTML 在这份审阅稿之后改过。要按新版重转，先把旧审阅稿移进废纸篓。"));
}
