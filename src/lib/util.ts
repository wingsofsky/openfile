/** 快捷键提示里的修饰键：mac 显示 ⌘，其余显示 Ctrl+（Gemini 冷审查：Windows 上写 ⌘ 极不友好） */
export const MOD: string = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? "⌘" : "Ctrl+";

type ViewerKind =
  | "markdown"
  | "html"
  | "docx"
  | "pdf"
  | "image"
  | "text"
  | "binary";

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);
const BINARY_EXTS = new Set([
  "doc", "ppt", "pptx", "xls", "xlsx", "zip", "gz", "tar", "7z", "rar",
  "dmg", "app", "exe", "dylib", "so", "bin", "ttf", "otf", "woff", "woff2",
  "mp3", "mp4", "mov", "wav", "sqlite", "db", "pyc", "ipynb_checkpoints",
]);

export function viewerKindOf(ext: string): ViewerKind {
  const e = ext.toLowerCase();
  if (e === "md" || e === "markdown" || e === "mdx") return "markdown";
  if (e === "html" || e === "htm") return "html";
  if (e === "docx") return "docx";
  if (e === "pdf") return "pdf";
  if (IMAGE_EXTS.has(e)) return "image";
  if (BINARY_EXTS.has(e)) return "binary";
  return "text";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 自然序比较（"ch2" < "ch10"），中文按拼音集合序，用于树的视觉排序 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, ["zh-Hans", "en"], {
    numeric: true,
    sensitivity: "base",
  });
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

export function baseName(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

/** 以 from 文件所在目录解析一个相对链接（用于 md 内相对路径跳转/图片） */
export function resolveRel(fromFile: string, link: string): string {
  const parts = parentOf(fromFile).split("/").filter(Boolean);
  for (const seg of link.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return ""; // 越出库根，交给调用方拒绝
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

export function isExternalUrl(u: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//");
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}
