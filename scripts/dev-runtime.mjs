/**
 * 浏览器开发 / E2E 的运行时传输（vite dev server 中间件）。
 * 后端就是桌面 sidecar 用的同一个 packages/runtime/src/api/host.ts，这里只做 HTTP 搬运：
 *
 *   POST /__rpc            {method, params} → {result}；出错按 error.status 给 HTTP 状态码 + {error}
 *   GET  /__rpc/events     SSE：宿主的全部事件（{ws, type, …}）
 *   GET  /__fs/raw/<rel>   库内文件原样（fileUrl 用；同 Tauri asset 协议）
 *
 * 闸门：Host/Origin 校验，POST 要 application/json + x-openfile-request: 1（dev-request.mjs）。
 * 设置只在内存（不碰用户的桌面 settings.json）；只在 `vite dev` 进程内存在，生产构建不含此代码。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScoped, MAX_CAP } from "../packages/runtime/src/lib/scoped.mjs";
import { Host } from "../packages/runtime/src/api/host.ts";
import { assertDevRequest } from "./dev-request.mjs";

const MIME = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  pdf: "application/pdf",
  md: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** dev 态会话注入的 MCP 用仓库里的运行时源码（本进程的 Node 直跑 TypeScript） */
export const devCliEntry = fileURLToPath(new URL("../packages/runtime/src/cli.ts", import.meta.url));

const httpErr = (status, message) => Object.assign(new Error(message), { status });

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    req.on("data", (c) => {
      if (oversized) return;
      bytes += c.length;
      if (bytes > MAX_CAP + 1024 * 1024) {
        oversized = true;
        chunks.length = 0;
        reject(httpErr(413, "body 过大"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!oversized) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

const json = (res, obj, status = 200) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
};

export function devRuntime() {
  return {
    name: "openfile-dev-runtime",
    apply: "serve",
    configureServer(server) {
      // `pnpm tauri dev` 的 beforeDevCommand 也是这个 vite：桌面端走 sidecar，这里不再起第二个后端
      //（否则同一个库上两套监听、索引、自动快照）
      if (process.env.TAURI_ENV_PLATFORM) return;
      const clients = new Set();
      const host = new Host({
        settingsFile: null,
        cliEntry: devCliEntry,
        emit: (ws, e) => {
          const frame = `data: ${JSON.stringify({ ws, ...e })}\n\n`;
          for (const res of clients) res.write(frame);
        },
      });
      // dev server 关停：不留孤儿会话进程（Windows 上连孙进程一起，同步杀完再让进程退出）
      server.httpServer?.on("close", () => host.shutdown());
      const envRoot = process.env.OPENFILE_LIBRARY;
      if (envRoot) {
        try {
          host.open("main", path.resolve(envRoot), false);
        } catch (e) {
          server.config.logger.warn(`[dev-runtime] OPENFILE_LIBRARY 无效: ${e.message}`);
        }
      }

      server.middlewares.use(async (req, res, next) => {
        try {
          let url;
          try {
            url = new URL(req.url, "http://localhost");
          } catch {
            throw httpErr(400, "非法请求地址");
          }
          const isRaw = url.pathname.startsWith("/__fs/raw/");
          if (url.pathname !== "/__rpc" && url.pathname !== "/__rpc/events" && !isRaw) return next();
          const address = server.httpServer?.address();
          assertDevRequest(req, {
            port: typeof address === "object" && address ? address.port : server.config.server.port,
            host: server.config.server.host,
            https: !!server.config.server.https,
          }, isRaw);

          if (url.pathname === "/__rpc") {
            if (req.method !== "POST") throw httpErr(405, "只接受 POST");
            const body = JSON.parse((await readBody(req)) || "{}");
            if (typeof body.method !== "string") throw httpErr(400, "缺少 method");
            // internal.* 只给桌面宿主（Rust）用；library.closeWindow 由宿主在窗口关掉时调
            if (body.method.startsWith("internal.")) throw httpErr(404, `未知方法 ${body.method}`);
            const result = await host.call(body.method, body.params ?? {});
            return json(res, { result: result ?? null });
          }
          if (url.pathname === "/__rpc/events") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
            res.write(": connected\n\n");
            clients.add(res);
            const ping = setInterval(() => res.write(": ping\n\n"), 15000);
            req.on("close", () => {
              clearInterval(ping);
              clients.delete(res);
            });
            return;
          }
          // 库内文件原样（fileUrl）：出证同 fs.readText；直接打开库里的 HTML/SVG 也拿不到 dev 源的 API
          const rel = decodeURIComponent(url.pathname.slice("/__fs/raw/".length));
          const abs = resolveScoped(host.workspace(url.searchParams.get("ws") ?? "main").root, rel);
          const st = await fsp.stat(abs);
          if (!st.isFile()) throw httpErr(400, "不是文件");
          const ext = path.extname(abs).slice(1).toLowerCase();
          res.statusCode = 200;
          res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
          res.setHeader("content-length", st.size);
          res.setHeader("cache-control", "no-store");
          res.setHeader("x-content-type-options", "nosniff");
          res.setHeader("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
          fs.createReadStream(abs).pipe(res);
        } catch (e) {
          if (res.headersSent) return res.end();
          return json(res, { error: e?.message ?? String(e) }, e?.status ?? 500);
        }
      });
    },
  };
}
