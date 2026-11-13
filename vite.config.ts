/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import os from "node:os";
import path from "node:path";
// @ts-expect-error 纯 JS vite 插件（dev-only：运行时 API 的 HTTP 传输）
import { devRuntime } from "./scripts/dev-runtime.mjs";
// @ts-expect-error 纯 JS vite 插件（pdf.js 的 CMap / 字体 / wasm，开发态提供、构建时打包）
import { pdfjsAssets } from "./scripts/pdfjs-assets.mjs";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), devRuntime(), pdfjsAssets()],

  define: {
    // 状态栏构建信标：一眼分辨跑的是哪个包（排查"改了没生效"类问题）
    __OPENFILE_BUILD__: JSON.stringify(
      command === "build"
        ? new Date().toISOString().slice(2, 16).replace("T", " ")
        : "dev",
    ),
  },

  // Tauri 约定
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 只听本机：开发桥能读写文库、拉起程序，不给局域网
    host: false,
    headers: {
      // The srcdoc meta policy controls resources, not navigation of its own
      // iframe. Enforce the frame destination from the trusted parent response.
      "Content-Security-Policy": "frame-src 'self' asset: http://asset.localhost blob:",
    },
    watch: {
      // src-tauri：Rust 侧自管；md/docs：dogfood 时文库就是本仓库，
      // 审阅写盘不能触发 vite 整页 reload（md 不是模块，忽略无害）
      ignored: ["**/src-tauri/**", "**/*.md", "**/docs/**"],
    },
  },

  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.{ts,mjs}", "tests/**/*.test.{ts,mjs}"],
    css: false,
    // Windows 的 CI 机器上起 git、建影子仓库常过 5 秒；超时后清理目录又撞 EBUSY，整串误报
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    // Openfile 主文件夹改道到临时目录：测试与它拉起的子进程都不读写本机真实的 ~/.openfile
    env: { OPENFILE_HOME: path.join(os.tmpdir(), `openfile-test-home-${process.pid}`, ".openfile") },
  },
}));
