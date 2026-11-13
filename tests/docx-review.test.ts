// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { docxRelFor, docxRevisionView, exportRelFor, reviewRelFor, reviewToEdits } from "../packages/runtime/src/lib/docx-review.ts";
import { exportDocxBound, importDocxBound } from "../packages/runtime/src/api/workspace.ts";
import { tempDir } from "./helpers/paths.ts";
import { linkDir } from "./helpers/links.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "review-sample.docx");

function lib() {
  const root = tempDir("openfile-docx-");
  fs.mkdirSync(path.join(root, "论文"));
  fs.copyFileSync(FIXTURE, path.join(root, "论文", "第二章.docx"));
  return root;
}

describe("docx-review 命名", () => {
  it("审阅稿与导出稿的名字", () => {
    expect(reviewRelFor("论文/第二章.docx")).toBe("论文/第二章.docx.review.md");
    expect(docxRelFor("论文/第二章.docx.review.md")).toBe("论文/第二章.docx");
    expect(docxRelFor("论文/第二章.md")).toBeNull();
    const taken = new Set(["a.reviewed.docx"]);
    expect(exportRelFor("a.docx", (r) => taken.has(r))).toBe("a.reviewed-2.docx");
  });
});

describe("reviewToEdits", () => {
  const base = "本研究采用定性方法，问卷于春季发放，回收有效问卷 112 份。";
  it("替换与删除按原文位置钉住，插入与批注用左侧唯一上下文作锚", () => {
    const reviewed =
      "本研究采用{~~@a: 定性~>混合~~}方法，问卷于{--@a: 春季--}发放，回收{++@b: 纸质++}有效问卷 {==112 份==}{>>@导师: 依据？<<}。";
    const edits = reviewToEdits(base, reviewed, "me");
    expect(edits).toEqual([
      { author: "a", edit: { type: "modify", target_text: "定性", new_text: "混合", _match_start_index: base.indexOf("定性") } },
      { author: "a", edit: { type: "modify", target_text: "春季", new_text: "", _match_start_index: base.indexOf("春季") } },
      { author: "b", edit: { type: "modify", target_text: "收", new_text: "收纸质" } },
      { author: "导师", edit: { type: "modify", target_text: "112 份", new_text: "112 份", comment: "依据？" } },
    ]);
  });

  it("没写作者的修订记在默认作者名下；单独的高亮跳过", () => {
    const edits = reviewToEdits(base, "本研究采用{++新的++}定性方法，{==问卷==}于春季发放，回收有效问卷 112 份。", "me");
    expect(edits.map((e) => e.author)).toEqual(["me"]);
  });
});

describe("Word 往返（导入 → 审阅 → 导出）", () => {
  it("导出原生修订：字级精度、多作者、批注；原件不动，导出不覆盖", async () => {
    const root = lib();
    try {
      const original = fs.readFileSync(path.join(root, "论文/第二章.docx"));
      const imp = await importDocxBound(root, "论文/第二章.docx", root);
      expect(imp).toEqual({ rel: "论文/第二章.docx.review.md", created: true, hadMarkup: false });
      const reviewAbs = path.join(root, imp.rel);
      const text = fs.readFileSync(reviewAbs, "utf8");
      expect(text).toContain("本研究采用定性方法");
      // 再导入一次：沿用已有审阅稿，不覆盖
      fs.writeFileSync(reviewAbs, text.replace("定性", "{~~@alice: 定性~>混合~~}").replace("回收有效问卷", "回收{++@claude: 纸质++}有效问卷"));
      expect((await importDocxBound(root, "论文/第二章.docx", root)).created).toBe(false);
      expect(fs.readFileSync(reviewAbs, "utf8")).toContain("{~~@alice: 定性~>混合~~}");

      const out = await exportDocxBound(root, imp.rel, "me", root);
      expect(out).toEqual({ rel: "论文/第二章.reviewed.docx", applied: 2 });
      // 视图在每条修订后附一段 {>>[Chg:…]<<} 元数据，比对前去掉
      const view = (await docxRevisionView(fs.readFileSync(path.join(root, out.rel)))).replace(/\{>>\[Chg[\s\S]*?<<\}/g, "");
      expect(view).toContain("本研究采用{--定性--}{++混合++}");
      expect(view).toContain("回收{++纸质++}有效问卷");
      expect(fs.readFileSync(path.join(root, "论文/第二章.docx")).equals(original)).toBe(true);
      // 第二次导出另起名字
      expect((await exportDocxBound(root, imp.rel, "me", root)).rel).toBe("论文/第二章.reviewed-2.docx");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("正文绕开修订标记被改过就拒绝导出，不出稿", async () => {
    const root = lib();
    try {
      const { rel } = await importDocxBound(root, "论文/第二章.docx", root);
      const abs = path.join(root, rel);
      fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace("定性", "混合"));
      await expect(exportDocxBound(root, rel, "me", root)).rejects.toThrow(/对不上/);
      expect(fs.existsSync(path.join(root, "论文/第二章.reviewed.docx"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("路径攻击与换库一律拒绝，零副作用", async () => {
    const root = lib();
    const outside = tempDir("openfile-docx-out-");
    try {
      fs.copyFileSync(FIXTURE, path.join(outside, "x.docx"));
      linkDir(outside, path.join(root, "escape"));
      for (const rel of ["../x.docx", path.join(outside, "x.docx"), "x\0.docx", "escape/x.docx"]) {
        await expect(importDocxBound(root, rel, root)).rejects.toThrow();
        await expect(exportDocxBound(root, `${rel}.review.md`, "me", root)).rejects.toThrow();
      }
      await expect(importDocxBound(root, "论文/第二章.docx", outside)).rejects.toThrow(/文库/);
      await expect(importDocxBound(root, "论文/第二章.md", root)).rejects.toThrow(/docx/);
      expect(fs.readdirSync(outside)).toEqual(["x.docx"]);
      expect(fs.readdirSync(path.join(root, "论文"))).toEqual(["第二章.docx"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
