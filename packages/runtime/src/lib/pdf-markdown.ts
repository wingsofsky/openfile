/**
 * 文献 PDF → Markdown 笔记。转换交给本机装的 Docling（MIT，`uv tool install docling`），不打包进来：
 * 它要 Python 与几百 MB 的模型。
 *
 * - 找 Docling：环境变量 OPENFILE_DOCLING（docling 可执行文件的路径）→ PATH → ~/.local/bin（uv / pipx 的默认位置）。
 *   用它所在虚拟环境的 python 跑一段脚本，逐页 export_to_markdown(page_no=…)：页码直接取自 PDF，空白页也不会数错。
 *   命令行版没有分页标记的选项，所以不走 `docling convert`。
 * - 产物 `<名字>.pdf.md` 放在 PDF 旁边；每页前一行 `[p. N](<名字>.pdf#page=N)`，点它跳回 PDF 那一页。
 *   已经有了就沿用（接着读、接着批），不覆盖。中间文件放系统临时目录，用完删掉，文库里不留别的东西。
 * - 后处理两处：中文换行处 Docling 插的空格去掉；`&amp;` 还原成 `&`（否则选中带 & 的句子批注时对不上源码）。
 * - 子进程关 stdin、windowsHide；首次运行要下载模型，给 20 分钟。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PDF_NOTES_SUFFIX = ".md";
const TIMEOUT_MS = 20 * 60 * 1000;

/** `论文/x.pdf` → `论文/x.pdf.md` */
export function notesRelFor(pdfRel: string): string {
  return pdfRel + PDF_NOTES_SUFFIX;
}

export class DoclingMissingError extends Error {}

/** Docling 的可执行文件与它虚拟环境里的 python；找不到给 null */
export function findDocling(env: NodeJS.ProcessEnv = process.env): { docling: string; python: string } | null {
  const win = process.platform === "win32";
  const exe = win ? "docling.exe" : "docling";
  const candidates = [
    env.OPENFILE_DOCLING,
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
    path.join(os.homedir(), ".local", "bin", exe),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(c);
      if (!fs.statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    // uv / pipx / venv：docling 与 python 在同一个 bin（Windows 是 Scripts）目录
    const python = path.join(path.dirname(real), win ? "python.exe" : "python");
    if (fs.existsSync(python)) return { docling: real, python };
  }
  return null;
}

const SCRIPT = `
import json, sys
from docling.document_converter import DocumentConverter
src, out = sys.argv[1], sys.argv[2]
doc = DocumentConverter().convert(src).document
pages = [{"page": p, "md": doc.export_to_markdown(page_no=p)} for p in sorted(doc.pages)]
with open(out, "w", encoding="utf-8") as f:
    json.dump({"pages": pages}, f, ensure_ascii=False)
`;

const CJK = "\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef";
const CJK_GAP = new RegExp(`(?<=[${CJK}]) (?=[${CJK}])`, "g");

/** 每页的 Markdown 拼成笔记：页标记 + 正文 */
export function buildNotes(pdfName: string, pages: Array<{ page: number; md: string }>): string {
  const target = /[\s<>()]/.test(pdfName) ? `<${pdfName.replace(/[<>]/g, "")}` : pdfName;
  const close = target.startsWith("<") ? ">" : "";
  const out: string[] = [];
  for (const { page, md } of pages) {
    out.push(`[p. ${page}](${target}#page=${page}${close})`);
    const body = md.replace(/&amp;/g, "&").replace(CJK_GAP, "").trim();
    if (body) out.push(body);
  }
  return out.join("\n\n") + "\n";
}

/** 跑 Docling 把 PDF 转成按页的 Markdown */
export async function convertPdf(pdfAbs: string): Promise<Array<{ page: number; md: string }>> {
  const found = findDocling();
  if (!found) {
    throw new DoclingMissingError("没找到 Docling。在终端运行 uv tool install docling（或 pipx install docling），装好后再试。");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openfile-docling-"));
  const out = path.join(dir, "pages.json");
  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn(found.python, ["-I", "-c", SCRIPT, pdfAbs, out], {
        cwd: dir,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1" },
      });
      let err = "";
      child.stderr.on("data", (b: Buffer) => {
        err = (err + b.toString()).slice(-4000);
      });
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(err);
        else reject(new Error(`Docling 转换失败（退出码 ${code}）：${lastLine(err)}`));
      });
    });
    if (!fs.existsSync(out)) throw new Error(`Docling 没有产出结果：${lastLine(stderr)}`);
    const parsed = JSON.parse(fs.readFileSync(out, "utf8")) as { pages: Array<{ page: number; md: string }> };
    return parsed.pages;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Loading weights|^W\d{4} |NOTE: Redirects/.test(l));
  return lines.at(-1)?.slice(0, 300) ?? "";
}
