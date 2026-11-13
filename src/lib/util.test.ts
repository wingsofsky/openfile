import { describe, expect, it } from "vitest";
import {
  baseName,
  extOf,
  formatBytes,
  isExternalUrl,
  naturalCompare,
  parentOf,
  resolveRel,
  viewerKindOf,
} from "./util";

describe("viewerKindOf", () => {
  it("按扩展名归类", () => {
    expect(viewerKindOf("md")).toBe("markdown");
    expect(viewerKindOf("MD".toLowerCase())).toBe("markdown");
    expect(viewerKindOf("html")).toBe("html");
    expect(viewerKindOf("docx")).toBe("docx");
    expect(viewerKindOf("pdf")).toBe("pdf");
    expect(viewerKindOf("png")).toBe("image");
    expect(viewerKindOf("zip")).toBe("binary");
    expect(viewerKindOf("py")).toBe("text");
    expect(viewerKindOf("")).toBe("text");
  });
});

describe("resolveRel", () => {
  it("相对当前文件目录解析", () => {
    expect(resolveRel("docs/a.md", "img/x.png")).toBe("docs/img/x.png");
    expect(resolveRel("docs/a.md", "./b.md")).toBe("docs/b.md");
    expect(resolveRel("docs/a.md", "../top.md")).toBe("top.md");
    expect(resolveRel("a.md", "b.md")).toBe("b.md");
  });

  it("越出库根返回空串（由调用方拒绝）", () => {
    expect(resolveRel("a.md", "../x.md")).toBe("");
    expect(resolveRel("docs/a.md", "../../../etc/passwd")).toBe("");
  });
});

describe("naturalCompare", () => {
  it("数字感知排序", () => {
    const arr = ["ch10.md", "ch2.md", "ch1.md"].sort(naturalCompare);
    expect(arr).toEqual(["ch1.md", "ch2.md", "ch10.md"]);
  });
});

describe("formatBytes", () => {
  it("分档格式化", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("路径工具", () => {
  it("parentOf / baseName / extOf", () => {
    expect(parentOf("a/b/c.md")).toBe("a/b");
    expect(parentOf("c.md")).toBe("");
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(extOf("x.tar.gz")).toBe("gz");
    expect(extOf(".gitignore")).toBe("");
    expect(extOf("noext")).toBe("");
  });
});

describe("isExternalUrl", () => {
  it("识别协议链接", () => {
    expect(isExternalUrl("https://a.b")).toBe(true);
    expect(isExternalUrl("mailto:x@y.z")).toBe(true);
    expect(isExternalUrl("//cdn.example")).toBe(true);
    expect(isExternalUrl("docs/a.md")).toBe(false);
    expect(isExternalUrl("./a.md")).toBe(false);
  });
});
