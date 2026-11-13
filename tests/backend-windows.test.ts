// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assetUrlFallback, libraryAbsPath } from "../src/lib/backend";

describe("资源路径：库根 + 库内相对路径", () => {
  it("mac/Linux 输出不变", () => {
    expect(libraryAbsPath("/Users/me/我的库", "docs/图.png")).toBe("/Users/me/我的库/docs/图.png");
    expect(libraryAbsPath("/Users/me/lib", "")).toBe("/Users/me/lib/");
  });

  it("Windows 根：统一反斜杠（不再拼出 D:\\lib/docs/a.png）", () => {
    expect(libraryAbsPath("D:\\我的库", "docs/图.png")).toBe("D:\\我的库\\docs\\图.png");
    expect(libraryAbsPath("D:\\我的库\\", "a.png")).toBe("D:\\我的库\\a.png");
    expect(libraryAbsPath("D:\\", "a.png")).toBe("D:\\a.png");
    expect(libraryAbsPath("D:\\我的库", "")).toBe("D:\\我的库\\");
    expect(libraryAbsPath("\\\\srv\\share\\lib", "x/y.pdf")).toBe("\\\\srv\\share\\lib\\x\\y.pdf");
  });

  it("剥 \\\\?\\ 前缀：前缀下 / 不是分隔符，混拼的路径打不开", () => {
    expect(libraryAbsPath("\\\\?\\D:\\我的库", "docs/a.png")).toBe("D:\\我的库\\docs\\a.png");
    expect(libraryAbsPath("\\\\?\\UNC\\srv\\share\\lib", "a.png")).toBe("\\\\srv\\share\\lib\\a.png");
  });
});

describe("asset URL 兜底（convertFileSrc 未加载完时）", () => {
  it("mac/Linux：asset://localhost + 逐段编码（行为不变）", () => {
    expect(assetUrlFallback("/Users/me/我的 库/a.png")).toBe(
      `asset://localhost//Users/me/${encodeURIComponent("我的 库")}/a.png`,
    );
  });

  it("Windows：http://asset.localhost + 整体编码（同 Tauri convertFileSrc 的 Windows 格式）", () => {
    const abs = "D:\\我的库\\docs\\a.png";
    expect(assetUrlFallback(abs)).toBe(`http://asset.localhost/${encodeURIComponent(abs)}`);
    expect(assetUrlFallback(abs)).toBe("http://asset.localhost/D%3A%5C%E6%88%91%E7%9A%84%E5%BA%93%5Cdocs%5Ca.png");
  });
});
