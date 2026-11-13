// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildNotes, findDocling, notesRelFor } from "../packages/runtime/src/lib/pdf-markdown.ts";
import { pdfToMarkdownBound } from "../packages/runtime/src/api/workspace.ts";
import { tempDir } from "./helpers/paths.ts";
import { linkDir } from "./helpers/links.ts";

describe("buildNotes", () => {
  it("每页前一行跳回 PDF 那一页的链接；空页只留链接", () => {
    const md = buildNotes("paper.pdf", [
      { page: 1, md: "## Title\n\nBody one." },
      { page: 2, md: "" },
      { page: 3, md: "Body three." },
    ]);
    expect(md).toBe("[p. 1](paper.pdf#page=1)\n\n## Title\n\nBody one.\n\n[p. 2](paper.pdf#page=2)\n\n[p. 3](paper.pdf#page=3)\n\nBody three.\n");
  });

  it("文件名带空格或括号用尖括号包住；中文换行处的空格去掉；&amp; 还原", () => {
    const md = buildNotes("A (draft) paper.pdf", [{ page: 1, md: "半结构化访 谈。Lee &amp; Park, a b." }]);
    expect(md).toBe("[p. 1](<A (draft) paper.pdf#page=1>)\n\n半结构化访谈。Lee & Park, a b.\n");
  });

  it("笔记名", () => {
    expect(notesRelFor("论文/x.pdf")).toBe("论文/x.pdf.md");
  });
});

describe("findDocling", () => {
  it("OPENFILE_DOCLING 指定的 docling 旁边有 python 才算找到", () => {
    const dir = tempDir("openfile-docling-bin-");
    try {
      const exe = path.join(dir, process.platform === "win32" ? "docling.exe" : "docling");
      fs.writeFileSync(exe, "");
      const empty = { PATH: "" } as NodeJS.ProcessEnv;
      expect(findDocling({ ...empty, OPENFILE_DOCLING: exe })?.docling ?? null).not.toBe(fs.realpathSync(exe));
      const python = path.join(dir, process.platform === "win32" ? "python.exe" : "python");
      fs.writeFileSync(python, "");
      expect(findDocling({ ...empty, OPENFILE_DOCLING: exe })).toEqual({ docling: fs.realpathSync(exe), python: path.join(fs.realpathSync(dir), path.basename(python)) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pdfToMarkdownBound", () => {
  it("已有笔记就沿用，不转换、不覆盖", async () => {
    const root = tempDir("openfile-pdfmd-");
    try {
      fs.writeFileSync(path.join(root, "a.pdf"), "%PDF-1.4");
      fs.writeFileSync(path.join(root, "a.pdf.md"), "my notes");
      expect(await pdfToMarkdownBound(root, "a.pdf", root)).toEqual({ rel: "a.pdf.md", created: false, pages: 0 });
      expect(fs.readFileSync(path.join(root, "a.pdf.md"), "utf8")).toBe("my notes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("路径攻击、换库、非 PDF 一律拒绝，零副作用", async () => {
    const root = tempDir("openfile-pdfmd-");
    const outside = tempDir("openfile-pdfmd-out-");
    try {
      fs.writeFileSync(path.join(outside, "x.pdf"), "%PDF-1.4");
      linkDir(outside, path.join(root, "escape"));
      for (const rel of ["../x.pdf", path.join(outside, "x.pdf"), "x\0.pdf", "escape/x.pdf"]) {
        await expect(pdfToMarkdownBound(root, rel, root)).rejects.toThrow();
      }
      fs.writeFileSync(path.join(root, "a.pdf"), "%PDF-1.4");
      await expect(pdfToMarkdownBound(root, "a.pdf", outside)).rejects.toThrow(/文库/);
      await expect(pdfToMarkdownBound(root, "a.md", root)).rejects.toThrow(/pdf/);
      expect(fs.readdirSync(outside)).toEqual(["x.pdf"]);
      expect(fs.readdirSync(root).sort()).toEqual(["a.pdf", "escape"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
