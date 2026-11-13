/**
 * pdf.js 运行时按基础 URL 取的资源：CMap（中日韩字体要用）、标准 14 字体、wasm 解码器
 * （JPEG2000 / JBIG2 / ICC 色彩，带纯 JS 兜底）、CMYK 用的 ICC 配置文件。
 * 开发态从 node_modules/pdfjs-dist 直接提供，构建时原样打进 dist/pdfjs/。只认这四个目录里的现有文件名（白名单，
 * 不拼路径）；PDF 脚本沙箱（quickjs）用不到，不带。src/viewers/PdfView.tsx 按 /pdfjs/<目录>/ 取。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];
const SKIP = /^quickjs/;
const TYPES = { ".wasm": "application/wasm", ".js": "text/javascript" };

export function pdfjsAssets() {
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  let files = null;
  const list = () =>
    (files ??= new Set(DIRS.flatMap((d) => fs.readdirSync(path.join(root, d)).filter((n) => !SKIP.test(n)).map((n) => `${d}/${n}`))));
  return {
    name: "openfile-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        let rel;
        try {
          rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        } catch {
          return next();
        }
        if (req.method !== "GET" || !list().has(rel)) return next();
        res.setHeader("content-type", TYPES[path.extname(rel)] ?? "application/octet-stream");
        // 依赖重装时文件可能不在了：流出错只断这条响应，不让 dev 服务器崩
        fs.createReadStream(path.join(root, rel)).on("error", () => res.destroy()).pipe(res);
      });
    },
    generateBundle() {
      for (const rel of list()) this.emitFile({ type: "asset", fileName: `pdfjs/${rel}`, source: fs.readFileSync(path.join(root, rel)) });
    },
  };
}
