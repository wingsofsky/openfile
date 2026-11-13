import type { TextRead } from "./types";

/** Scoped readers strip UTF-8 BOMs: the file had one when it is exactly 3 bytes longer than the decoded text. null = neither 0 nor 3 extra bytes. */
function extraBomBytes(read: TextRead): number | null {
  const extra = read.size - new TextEncoder().encode(read.content).length;
  return extra === 0 || extra === 3 ? extra : null;
}

/** The BOM to put back when writing a complete UTF-8 read back (review-mode typing). */
export function readBom(read: TextRead): string {
  return !read.truncated && read.encoding === "utf-8" && extraBomBytes(read) === 3 ? "\uFEFF" : "";
}
