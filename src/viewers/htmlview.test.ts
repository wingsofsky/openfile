import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { buildSrcdoc, HtmlView } from "./HtmlView";
import { LINK_TAP_JS } from "./linktap";
import { openExternal } from "../lib/external";
import { useApp } from "../state/store";
import { setLocale } from "../i18n";

vi.mock("../lib/backend", () => ({
  backend: {
    kind: "dev",
    readText: vi.fn((rel: string) =>
      Promise.resolve({
        content: `<head></head><body>DOC:${rel}</body>`,
        size: 27,
        truncated: false,
        encoding: "utf-8",
      }),
    ),
    fileUrl: (r: string) => `http://bridge/${r}`,
  },
}));
vi.mock("../lib/external", () => ({ openExternal: vi.fn() }));

describe("HtmlView.buildSrcdoc", () => {
  it.each(["/__fs/raw/docs/", "http://localhost:1420/__fs/raw/docs/", "http://asset.localhost/path/docs/", "asset://localhost/path/docs/"])("只放行本地资源，禁止外部资源源与文档自行改 base：%s", (base) => {
    const out = buildSrcdoc("<head></head>", base);
    const content = out.match(/Content-Security-Policy" content="([^"]+)/)![1];
    expect(content).not.toContain("*");
    expect(content).toContain("connect-src 'none'");
    expect(content).not.toContain("base-uri 'self'");
    const url = new URL(base, window.location.href);
    expect(content).toContain(url.protocol === "asset:" ? "asset:" : url.origin);
    expect(content).not.toMatch(/(?:img|media|font)-src[^;]*https:/);
  });
  it("有 head：可信头先于原文，原有标题和正文正常解析", () => {
    const out = buildSrcdoc("<html><head><title>x</title></head><body>y</body></html>", "http://b/dir/");
    const doc = new DOMParser().parseFromString(out, "text/html");
    expect(doc.compatMode).toBe("CSS1Compat");
    expect(doc.title).toBe("x");
    expect(doc.body.textContent).toBe("y");
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf('<base href="http://b/dir/">'));
    expect(out).toContain("__openfile_link");
    expect(out.indexOf("<base")).toBeLessThan(out.indexOf("<title>"));
  });

  it("无 head：整段前置", () => {
    const out = buildSrcdoc("<p>裸片段</p>", "http://b/");
    expect(out.startsWith("<!doctype html><html><head><meta http-equiv=")).toBe(true);
    expect(out).toContain("<p>裸片段</p>");
  });

  it.each([
    '<!-- <head> --> <html><head><title>注释伪头</title></head><body><p>正文</p></body></html>',
    '<img src="https://example.invalid/pixel"><head><title>前置图片</title></head><body>正文</body>',
    '<script>window.reportScript = true</script><head><title>前置脚本</title></head><body>正文</body>',
    '<p>没有 head</p>',
    '<!doctype html><html lang="zh-CN"><head><title>标准文档</title><style>p{margin:0}</style></head><body><p>正文</p></body></html>',
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><head></head><body>旧 doctype</body></html>',
  ])("HTML parser 始终先建立生效 head 内的可信策略：%s", (source) => {
    const out = buildSrcdoc(source, "http://b/docs/");
    expect(out.endsWith(source)).toBe(true);
    const doc = new DOMParser().parseFromString(out, "text/html");
    expect(doc.doctype?.name).toBe("html");
    expect(doc.compatMode).toBe("CSS1Compat");
    const [policy, base, script] = Array.from(doc.head.children);
    expect(policy?.tagName).toBe("META");
    expect(policy?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(policy?.getAttribute("content")).toContain("connect-src 'none'");
    expect(base?.tagName).toBe("BASE");
    expect(base?.getAttribute("href")).toBe("http://b/docs/");
    expect(script?.textContent).toBe(LINK_TAP_JS);
    expect(doc.querySelector("img")?.compareDocumentPosition(policy) ?? Node.DOCUMENT_POSITION_PRECEDING)
      .toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });

  it("base 引号转义（目录名带引号不能破标签）", () => {
    const out = buildSrcdoc("<head></head>", 'http://b/a"b/');
    expect(out).toContain('href="http://b/a%22b/"');
  });

  it("锚点接管：脚本拦 # 开头并在文档内滚动，其余 postMessage", () => {
    const out = buildSrcdoc("<head></head>", "http://b/");
    expect(out).toContain('charAt(0)==="#"');
    expect(out).toContain("scrollIntoView");
    expect(out).toContain("postMessage");
  });

  it("CSP hash 契约：壳 CSP 必须放行接管脚本的当前字节（srcdoc 继承壳 CSP）", () => {
    // WKWebView 会把 tauri.conf.json 的 CSP 继承进 srcdoc；接管脚本靠
    // script-src 里的 sha256 通行证执行。脚本字节一变，这里立刻红。
    // vitest cwd = 仓库根
    const conf = readFileSync("src-tauri/tauri.conf.json", "utf-8");
    const hash = createHash("sha256").update(LINK_TAP_JS, "utf8").digest("base64");
    expect(conf).toContain(`'sha256-${hash}'`);
  });
});

describe("HtmlView 宿主路由（iframe postMessage → tab / 系统浏览器）", () => {
  beforeEach(() => { setLocale("zh"); vi.mocked(openExternal).mockClear(); });

  it("库内文件开 tab、外链经宿主确认后打开、伪造来源被拒", async () => {
    const { container } = render(createElement(HtmlView, { rel: "docs/a.html" }));
    await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
    const frame = container.querySelector("iframe")!;
    const send = (href: string, source: Window | null) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { __openfile_link: href }, source }),
      );

    send("章节三.md#sec", frame.contentWindow); // 带锚点的相对文件链
    expect(useApp.getState().tabs.some((t) => t.rel === "docs/章节三.md")).toBe(true);

    send("https://example.com", frame.contentWindow);
    expect(openExternal).not.toHaveBeenCalled();
    await waitFor(() => expect(within(container).getByRole("button", { name: "打开外部链接" })).toBeTruthy());
    expect(within(container).getByText("https://example.com")).toBeTruthy();
    fireEvent.click(within(container).getByRole("button", { name: "打开外部链接" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com");

    send("../越界.md", frame.contentWindow); // resolveRel 返回 docs 上一级 = 库根，合法
    expect(useApp.getState().tabs.some((t) => t.rel === "越界.md")).toBe(true);

    send("evil.md", window); // 来源不是本视图的 iframe：一律忽略
    expect(useApp.getState().tabs.some((t) => t.rel === "docs/evil.md")).toBe(false);
    send("https://example.invalid/forged", window);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(within(container).queryByText("https://example.invalid/forged")).toBeNull();
  });

  it("文档脚本不能自动打开外链或替换正在确认的 URL，取消无出站动作", async () => {
    const { container } = render(createElement(HtmlView, { rel: "docs/scripted.html" }));
    await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
    const source = container.querySelector("iframe")!.contentWindow;
    const send = (href: string) => window.dispatchEvent(new MessageEvent("message", { data: { __openfile_link: href }, source }));
    send("https://example.invalid/first");
    await waitFor(() => expect(within(container).getByText("https://example.invalid/first")).toBeTruthy());
    send("https://example.invalid/replacement");
    expect(within(container).queryByText("https://example.invalid/replacement")).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(within(container).getByRole("button", { name: "取消" }));
    expect(within(container).queryByRole("button", { name: "打开外部链接" })).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("换文件 = 换全新 iframe 节点（srcdoc 热替换在真实引擎会白渲染）", async () => {
    const { container, rerender } = render(createElement(HtmlView, { rel: "docs/一.html" }));
    await waitFor(() =>
      expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("DOC:docs/一.html"),
    );
    const first = container.querySelector("iframe");
    rerender(createElement(HtmlView, { rel: "docs/二.html" }));
    await waitFor(() =>
      expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("DOC:docs/二.html"),
    );
    expect(container.querySelector("iframe")).not.toBe(first);
  });
});
