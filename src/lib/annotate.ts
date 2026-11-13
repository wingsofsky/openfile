/**
 * 阅读视图选区批注内核：把「人在渲染视图里选中的一段文字」定位回源码，
 * 生成 CriticMarkup 标记后的新全文（人在审阅里加批注的入口，纯函数可测）。
 *
 * 定位策略：渲染文本 = 源码剥掉 markdown 语法后的产物，纯文本段落
 * （中文散文的绝大多数）逐字等于源码。在选区所在 chunk 的源码里做
 * **唯一匹配**——找不到（跨格式/跨标记）或多处出现都拒绝并给出人话提示，
 * 与 MCP suggest_edit 同一套纪律。
 */
import { codeRanges, makeCritic, parseCritic } from "@openfile/protocol/criticmarkup";

export type AnnotateAction = "comment" | "del" | "sub" | "mark";

type AnnotateResult = { ok: true; next: string; at: number } | { ok: false; error: string };

export function planAnnotation(opts: {
  full: string;
  /** 选区所在 chunk 的源码及其在全文的字符偏移（缩小搜索域） */
  chunkSrc: string;
  chunkOffset: number;
  /** 阅读视图选中的纯文本（Selection.toString()） */
  selected: string;
  action: AnnotateAction;
  /** comment 的批注内容 / sub 的替换文本 */
  payload?: string;
  author: string;
  /** 选区起点在全文的精确偏移（审阅模式的渲染文字 ↔ 源码映射给出）；有它就不靠文字搜索 */
  at?: number;
}): AnnotateResult {
  const { full, chunkSrc, chunkOffset, selected, action, payload, author } = opts;
  if (!selected) return { ok: false, error: "没有选中内容" };

  const exact = opts.at !== undefined && full.slice(opts.at, opts.at + selected.length) === selected;
  const hits: number[] = exact ? [opts.at! - chunkOffset] : [];
  if (!exact) {
    let i = chunkSrc.indexOf(selected);
    while (i !== -1) {
      hits.push(i);
      i = chunkSrc.indexOf(selected, i + 1);
    }
  }
  if (hits.length === 0) {
    return {
      ok: false,
      error: "选中的文字带格式（加粗/链接等）或跨越了已有标记，无法直接定位——缩小选择到纯文本，或切到编辑模式处理",
    };
  }
  if (hits.length > 1) {
    return { ok: false, error: `选中的文字在本节出现 ${hits.length} 次——扩大选择让它唯一` };
  }
  const at = chunkOffset + hits[0];
  const end = at + selected.length;

  // 代码区一律字面量，不允许在其中落标记
  for (const [s, e] of codeRanges(full)) {
    if (at < e && end > s) {
      return { ok: false, error: "代码围栏/行内代码里的标记是字面量，不支持在此批注" };
    }
  }
  // 与已有审阅标记重叠：先处理旧标记再动这一段
  for (const seg of parseCritic(full)) {
    if (at < seg.end && end > seg.start) {
      return { ok: false, error: "选区与已有审阅标记重叠——先接受/拒绝该标记" };
    }
  }

  let insert: string;
  let verify: (s: ReturnType<typeof parseCritic>[number]) => boolean;
  if (action === "comment") {
    const text = (payload ?? "").trim();
    if (!text) return { ok: false, error: "批注内容为空" };
    // 高亮 + 批注（CriticMarkup 标准写法）：批注覆盖哪段文字写在文件里，导出 Word 时批注挂在这段上
    insert = `{==${selected}==}` + makeCritic.comment(text, author);
    verify = (s) => s.kind === "comment" && s.text === text;
  } else if (action === "mark") {
    // 只高亮不写批注（读文献时最常用）
    insert = `{==${selected}==}`;
    verify = (s) => s.kind === "mark" && s.text === selected;
  } else if (action === "del") {
    insert = makeCritic.del(selected, author);
    verify = (s) => s.kind === "del" && s.text === selected;
  } else {
    const text = payload ?? "";
    if (!text) return { ok: false, error: "替换文本为空（要删除请用「建议删除」）" };
    if (text === selected) return { ok: false, error: "替换文本与原文相同" };
    insert = makeCritic.sub(selected, text, author);
    verify = (s) => s.kind === "sub" && s.old === selected && s.newText === text;
  }

  const next = full.slice(0, at) + insert + full.slice(end);
  // 落盘前回验：拼出的标记必须解析回**逐字段等价**的语义
  // （防 ~>、<<} 等定界符提前闭合，写出"合法但被截断"的标记）
  const parsed = parseCritic(next).some(
    (s) => s.start >= at && s.start < at + insert.length && verify(s),
  );
  if (!parsed) {
    return { ok: false, error: "内容包含标记定界符（如 ~>、<<}），会写坏标记语法——换个措辞" };
  }
  return { ok: true, next, at };
}
