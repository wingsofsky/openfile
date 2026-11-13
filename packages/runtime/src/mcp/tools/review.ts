/** MCP 工具：审阅：读批注、建议修改、批注（CriticMarkup）。 */
import { z } from "zod";
import {
  agentNotes,
  countCritic,
  makeCritic,
  parseCritic,
} from "@openfile/protocol/criticmarkup";
import { withEol } from "@openfile/protocol/eol";
import { atomicWriteFile, resolveScoped, resolveWritePathCreating } from "../../lib/scoped.mjs";

import { ROOT } from "../context.ts";
import { ok, fail, guard, readFull, findUniqueOutsideCode, eolAt, trimCommonAffixes, verifyMarksParse, AUTHOR_RE, type ToolScope } from "../tool-kit.ts";

export function registerReviewTools({ registerTool }: ToolScope): void {
  registerTool(
    "read_annotations",
    {
      title: "读批注",
      description:
        "解析文档中的 CriticMarkup 审阅标记（{++ ++}/{-- --}/{~~ ~> ~~}/{>> <<}/{== ==}，@作者）与【给 agent 的话】",
      inputSchema: { path: z.string() },
    },
    guard(async ({ path: rel }: { path: string }) => {
      resolveScoped(ROOT, rel);
      const src = await readFull(rel);
      const lineOf = (at: number) => src.slice(0, at).split("\n").length;
      const marks = parseCritic(src).map((s) => ({
        kind: s.kind,
        line: lineOf(s.start),
        author: s.author ?? null,
        ...(s.kind === "sub" ? { old: s.old, new: s.newText } : { text: s.text }),
      }));
      const notes = agentNotes(src).map((n) => ({ line: lineOf(n.start), text: n.text }));
      return ok({ counts: countCritic(src), marks, agent_notes: notes });
    }),
  );

  registerTool(
    "suggest_edit",
    {
      title: "建议修改",
      description:
        "以 CriticMarkup 建议标记（署名、可逐条接受/拒绝）替换一处唯一文本。old_text 必须在文档中唯一出现（含空白逐字一致）；new_text 为空 = 建议删除。这是修改他人文档的**唯一**正当方式",
      inputSchema: {
        path: z.string(),
        old_text: z.string().min(1),
        new_text: z.string(),
        author: z.string().regex(AUTHOR_RE, "作者名不能含空白/冒号/花括号，≤32 字符"),
        note: z.string().max(500).optional().describe("附带批注（解释为什么这么改）"),
      },
    },
    guard(
      async ({
        path: rel,
        old_text,
        new_text,
        author,
        note,
      }: {
        path: string;
        old_text: string;
        new_text: string;
        author: string;
        note?: string;
      }) => {
        const who = author;
        if (old_text === new_text) return fail("old_text 与 new_text 相同，无事可做");
        const src = await readFull(rel);
        const hit = findUniqueOutsideCode(src, old_text);
        const at = hit.at;
        // 以文档原文为旧文本，新文本与批注换成文档的换行风格（CRLF 文档里不混进 LF）
        const eol = eolAt(src, hit.text);
        const oldText = hit.text;
        const newText = withEol(new_text, eol);
        if (note !== undefined) note = withEol(note, eol);
        if (oldText === newText) return fail("old_text 与 new_text 只差换行风格，无事可做");
        const { prefix, oldCore, newCore, suffix } = trimCommonAffixes(oldText, newText);
        let mark: string;
        const expect: { kind: string; old?: string; newText?: string; text?: string }[] = [];
        if (oldCore === "") {
          mark = makeCritic.ins(newCore, who);
          expect.push({ kind: "ins", text: newCore });
        } else if (newCore === "") {
          mark = makeCritic.del(oldCore, who);
          expect.push({ kind: "del", text: oldCore });
        } else {
          mark = makeCritic.sub(oldCore, newCore, who);
          expect.push({ kind: "sub", old: oldCore, newText: newCore });
        }
        if (note) {
          mark += makeCritic.comment(note, who);
          expect.push({ kind: "comment", text: note });
        }
        const candidate =
          src.slice(0, at) + prefix + mark + suffix + src.slice(at + oldText.length);
        verifyMarksParse(candidate, at, expect);
        atomicWriteFile(resolveWritePathCreating(ROOT, rel), candidate);
        return ok({ ok: true, path: rel, marker: mark.length > 200 ? mark.slice(0, 200) + "…" : mark });
      },
    ),
  );

  registerTool(
    "add_comment",
    {
      title: "加批注",
      description: "在唯一锚点文本之后插入署名批注 {>>@作者: 批注<<}（不改正文）",
      inputSchema: {
        path: z.string(),
        anchor_text: z.string().min(1).describe("批注插在这段唯一文本之后"),
        comment: z.string().min(1).max(2000),
        author: z.string().regex(AUTHOR_RE),
      },
    },
    guard(
      async ({
        path: rel,
        anchor_text,
        comment,
        author,
      }: {
        path: string;
        anchor_text: string;
        comment: string;
        author: string;
      }) => {
        const src = await readFull(rel);
        const hit = findUniqueOutsideCode(src, anchor_text);
        const at = hit.at;
        const text = withEol(comment, eolAt(src, hit.text));
        const mark = makeCritic.comment(text, author);
        const insertAt = at + hit.text.length;
        const candidate = src.slice(0, insertAt) + mark + src.slice(insertAt);
        verifyMarksParse(candidate, at, [{ kind: "comment", text }]);
        atomicWriteFile(resolveWritePathCreating(ROOT, rel), candidate);
        return ok({ ok: true, path: rel, marker: mark });
      },
    ),
  );
}
