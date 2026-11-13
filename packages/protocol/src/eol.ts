/**
 * 换行风格内核（纯逻辑，UI 与 MCP server 共用，勿加 DOM 或 Node 依赖）。
 *
 * Windows 上 Git for Windows 默认 core.autocrlf=true，文库里的文件常以 CRLF 检出；人用记事本存的也可能是 CRLF。
 * 纪律：读一律容忍 `\r\n`；写沿用文件原有的换行风格——不往 CRLF 文件里混 LF，也不把 LF 文件改成 CRLF。
 */

export type Eol = "\n" | "\r\n";

/**
 * 文本主导的换行风格：CRLF 多于裸 LF 才算 CRLF；没有换行 = LF。
 * 与 managed-block.ts 的 eolOf 同口径。
 */
export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/** 文本里的每个换行（`\r\n` 或 `\n`）统一成 eol；孤立的 `\r` 不动 */
export function withEol(text: string, eol: Eol): string {
  return eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 换行容错的逐字查找：needle 里的每个换行（`\n` 或 `\r\n`）匹配 haystack 里的 `\n` 或 `\r\n`，其余字符逐字一致。
 * 返回全部出现（含重叠，语义同 indexOf(needle, i + 1) 循环），text 是 haystack 里实际命中的原文。
 * agent 递来的锚点几乎总是 LF，文档可能是 CRLF——逐字 indexOf 永远对不上。
 */
export function findAllEolTolerant(haystack: string, needle: string): Array<{ index: number; text: string }> {
  if (needle === "") return [];
  const parts = needle.split(/\r?\n/);
  if (parts.length === 1) {
    const out: Array<{ index: number; text: string }> = [];
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push({ index: i, text: needle });
    return out;
  }
  // 以换行打头的锚点：不许从 CRLF 的 \r 与 \n 之间起算（那和从 \r 起算是同一处出现）
  const lead = parts[0] === "" ? "(?<!\\r)" : "";
  const re = new RegExp(lead + parts.map(escapeRe).join("\\r?\\n"), "g");
  const out: Array<{ index: number; text: string }> = [];
  for (let m = re.exec(haystack); m !== null; m = re.exec(haystack)) {
    out.push({ index: m.index, text: m[0] });
    re.lastIndex = m.index + 1;
  }
  return out;
}
