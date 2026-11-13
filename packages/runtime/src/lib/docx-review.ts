/**
 * Word 往返：docx ↔ 审阅稿（Markdown + CriticMarkup）。读写 OOXML 交给 @adeu/core（MIT）。
 *
 * - 导入：docx 的「接受修订后」正文投影成 Markdown，存成旁边的 `<名字>.docx.review.md`。人在阅读器审阅模式里改，
 *   改动是普通的 CriticMarkup。
 * - 导出：每条修订直接翻成一条 Adeu 编辑，按作者分批写回原 docx 的副本，得到 Word 原生修订（w:ins / w:del）
 *   与批注。不走 Adeu 的整篇比对：中文没有空格，它会把整句当一个词删掉重插。
 *   替换与删除按原文位置钉住（字级精度）；插入与批注用左边最短的全文唯一上下文作锚，
 *   这样引擎才会生成纯插入 / 纯批注，而不是「删掉锚点再插回」。
 * - 安全门：审阅稿「全部拒绝」后必须逐字等于 docx 当前的投影。docx 导入后被改过、或有人绕开修订标记改了正文，
 *   就拒绝导出——宁可不出稿，不出错稿。
 * - 只接 `{==原文==}{>>批注<<}` 与挂在前文的裸批注；单独的高亮在 Word 里没有对应物，跳过。
 */
import { applyAll, parseCritic, type CriticSegment } from "@openfile/protocol/criticmarkup";

const REVIEW_SUFFIX = ".review.md";

/** `论文.docx` → `论文.docx.review.md` */
export function reviewRelFor(docxRel: string): string {
  return docxRel + REVIEW_SUFFIX;
}

/** 审阅稿对应的 docx；不是审阅稿给 null */
export function docxRelFor(reviewRel: string): string | null {
  if (!reviewRel.toLowerCase().endsWith(".docx" + REVIEW_SUFFIX)) return null;
  return reviewRel.slice(0, -REVIEW_SUFFIX.length);
}

/** 导出稿的名字：`论文.docx` → `论文.reviewed.docx`、`论文.reviewed-2.docx`…（taken 判断是否已占用） */
export function exportRelFor(docxRel: string, taken: (rel: string) => boolean): string {
  const stem = docxRel.replace(/\.docx$/i, "");
  for (let i = 1; ; i++) {
    const rel = `${stem}.reviewed${i === 1 ? "" : `-${i}`}.docx`;
    if (!taken(rel)) return rel;
  }
}

type Adeu = typeof import("@adeu/core");
let adeu: Promise<Adeu> | null = null;
/** 用到才加载：CLI 的其他命令不为它付启动时间 */
function loadAdeu(): Promise<Adeu> {
  adeu ??= import("@adeu/core");
  return adeu;
}

const lf = (s: string) => s.replace(/\r\n?/g, "\n");

/** docx → 审阅稿正文；hadMarkup = 原文件里已有修订或批注（审阅稿里看到的是接受修订后的正文） */
export async function docxToReview(bytes: Uint8Array): Promise<{ text: string; hadMarkup: boolean }> {
  const { extractTextFromBuffer } = await loadAdeu();
  const buf = Buffer.from(bytes);
  const clean = await extractTextFromBuffer(buf, true);
  const raw = await extractTextFromBuffer(buf, false);
  return { text: clean, hadMarkup: lf(raw) !== lf(clean) };
}

/** docx 的带修订视图（修订与批注也写成 CriticMarkup），核对导出结果用 */
export async function docxRevisionView(bytes: Uint8Array): Promise<string> {
  const { extractTextFromBuffer } = await loadAdeu();
  return extractTextFromBuffer(Buffer.from(bytes), false);
}

interface DocxEdit {
  author: string;
  edit: {
    type: "modify";
    target_text: string;
    new_text: string;
    comment?: string;
    _match_start_index?: number;
  };
}

function occurrences(hay: string, s: string): number {
  let n = 0;
  for (let i = hay.indexOf(s); i !== -1; i = hay.indexOf(s, i + 1)) n++;
  return n;
}

/** base 里位置 p 左边最短的全文唯一上下文（1–40 字）；找不到给 null */
function leftAnchor(base: string, p: number): string | null {
  for (let k = 1; k <= Math.min(40, p); k++) {
    const s = base.slice(p - k, p);
    if (occurrences(base, s) === 1) return s;
  }
  return null;
}

/**
 * 审阅稿里的修订 → Adeu 编辑。base 是审阅稿全部拒绝后的正文（= docx 投影）。
 * 每条编辑的位置都按 base 算，彼此独立，Adeu 一批里按原文定位。
 */
export function reviewToEdits(base: string, reviewed: string, fallbackAuthor: string): DocxEdit[] {
  const segs = parseCritic(reviewed);
  const out: DocxEdit[] = [];
  let shift = 0; // reviewed 偏移 − base 偏移
  segs.forEach((s: CriticSegment, i) => {
    const p = s.start - shift;
    const author = s.author ?? fallbackAuthor;
    if (s.kind === "ins") {
      const a = leftAnchor(base, p);
      out.push({
        author,
        edit: a !== null
          ? { type: "modify", target_text: a, new_text: a + s.text }
          : { type: "modify", target_text: base.slice(p, p + 1), new_text: s.text + base.slice(p, p + 1), _match_start_index: p },
      });
    } else if (s.kind === "del") {
      out.push({ author, edit: { type: "modify", target_text: s.text, new_text: "", _match_start_index: p } });
    } else if (s.kind === "sub") {
      out.push({ author, edit: { type: "modify", target_text: s.old ?? "", new_text: s.newText ?? "", _match_start_index: p } });
    } else if (s.kind === "comment") {
      const prev = segs[i - 1];
      const target = prev && prev.kind === "mark" && prev.end === s.start ? prev.text : leftAnchor(base, p);
      if (target) out.push({ author, edit: { type: "modify", target_text: target, new_text: target, comment: s.text } });
    }
    // base 里留下的长度：删除与高亮留原文，替换留旧文，插入与批注不占
    const kept = s.kind === "del" || s.kind === "mark" ? s.text.length : s.kind === "sub" ? (s.old ?? "").length : 0;
    shift += s.end - s.start - kept;
  });
  return out;
}

export class DocxReviewError extends Error {}

/** 把审阅稿写回 docx 的副本：返回新 docx 字节与生效的编辑数；任何一条落不下去都整体拒绝 */
export async function reviewToDocx(
  docx: Uint8Array,
  reviewed: string,
  fallbackAuthor: string,
): Promise<{ bytes: Uint8Array; applied: number }> {
  const { DocumentObject, RedlineEngine, extractTextFromBuffer } = await loadAdeu();
  const buf = Buffer.from(docx);
  const base = lf(await extractTextFromBuffer(buf, true));
  const text = lf(reviewed);
  if (applyAll(text, false) !== base) {
    throw new DocxReviewError(
      "审阅稿和 Word 原文对不上：原文件在导入后改过，或者正文有不在修订标记里的改动（比如在源码模式直接改了字）。没有导出。",
    );
  }
  const edits = reviewToEdits(base, text, fallbackAuthor);
  if (edits.length === 0) throw new DocxReviewError("审阅稿里没有修订或批注，没有可导出的内容。");
  const doc = await DocumentObject.load(buf);
  let applied = 0;
  for (const author of [...new Set(edits.map((e) => e.author))]) {
    const batch = edits.filter((e) => e.author === author).map((e) => e.edit);
    const result = new RedlineEngine(doc, author).process_batch(batch, undefined, true);
    const failed = (result?.failed ?? []) as unknown[];
    if (failed.length > 0 || (result?.edits_skipped ?? 0) > 0) {
      const sample = batch.find((_, k) => (result?.edits?.[k]?.status ?? "applied") !== "applied");
      throw new DocxReviewError(
        `有 ${failed.length || result.edits_skipped} 条修订写不回 Word${sample ? `（如「${sample.target_text.slice(0, 20)}」）` : ""}，没有导出。`,
      );
    }
    applied += result?.edits_applied ?? batch.length;
  }
  return { bytes: new Uint8Array(await doc.save()), applied };
}
