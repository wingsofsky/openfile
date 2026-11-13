/**
 * docx 本轮改动按段落标出。纯逻辑，有单测；渲染与快照 IO 在 viewers/DocxView.tsx。
 *
 * 契约：
 * - 轮前快照里的这份 docx 与磁盘当前的各用 docx-preview 渲一遍，取正文段落的纯文本按段落比（jsdiff）。
 *   正文 = 每页的 article 和脚注 / 尾注列表；每页重复的页眉页脚不算，免得加一页就多出一串「改动」。
 * - 改过、新增的段落在当前文档里标出；纯删除标在其后一段（删掉的看不见，标出它原来所在的位置），
 *   删在末尾就标最后一段。连续的增删算一处，与 md / txt 横幅上的「N 处」同义。
 * - docx 写不回逐段撤回：只标出，撤回只能整份回到轮前（agent-controller.undoTurnFile）。
 */
import { diffArrays } from "diff";

/** docx-preview 渲染结果里参与比较的段落（文档顺序） */
export const DOCX_PARAGRAPHS = "section.docx > article p, section.docx > ol p";

interface ParagraphChanges {
  /** 当前文档里要标出的段落：DOCX_PARAGRAPHS 选出的下标 */
  marked: Set<number>;
  /** 改动处数 */
  hunks: number;
}

export function changedParagraphs(base: readonly string[], current: readonly string[]): ParagraphChanges {
  const marked = new Set<number>();
  let hunks = 0;
  let at = 0; // current 里的位置
  let open = false; // 正处在一处改动里
  let added = false; // 这一处有没有新增 / 改写的段落
  const close = () => {
    // 纯删除：标其后一段，删在末尾标最后一段
    if (open && !added && current.length > 0) marked.add(Math.min(at, current.length - 1));
    open = false;
  };
  for (const part of diffArrays([...base], [...current])) {
    if (!part.added && !part.removed) {
      close();
      at += part.count;
      continue;
    }
    if (!open) {
      open = true;
      added = false;
      hunks++;
    }
    if (part.added) {
      added = true;
      for (let k = 0; k < part.count; k++) marked.add(at++);
    }
  }
  close();
  return { marked, hunks };
}
