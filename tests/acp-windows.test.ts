// @vitest-environment node
import { describe, expect, it } from "vitest";
import { absToRel, isWindowsAbsPath, plainPath, sliceLines } from "../src/lib/acp";

const ROOT = "D:\\资料\\我的库";

describe("absToRel —— Windows 路径（fs 代理的快速失败层）", () => {
  it("盘符绝对路径映射为 / 分隔的库内相对路径", () => {
    expect(absToRel(ROOT, "D:\\资料\\我的库\\docs\\第一章.md")).toBe("docs/第一章.md");
    expect(absToRel(ROOT, "D:\\资料\\我的库\\a.md")).toBe("a.md");
  });

  it("正斜杠、混用分隔符、重复分隔符、. 与 .. 词法归一", () => {
    expect(absToRel(ROOT, "D:/资料/我的库/docs/a.md")).toBe("docs/a.md");
    expect(absToRel(ROOT, "D:\\资料/我的库\\\\docs//a.md")).toBe("docs/a.md");
    expect(absToRel(ROOT, "D:\\资料\\我的库\\docs\\.\\..\\b.md")).toBe("b.md");
  });

  it("盘符与目录名不区分大小写（NTFS），返回保留 agent 给的大小写", () => {
    expect(absToRel(ROOT, "d:\\资料\\我的库\\Docs\\A.md")).toBe("Docs/A.md");
    expect(absToRel("C:\\Users\\Me\\Lib", "c:\\users\\me\\lib\\x.md")).toBe("x.md");
  });

  it("剥 \\\\?\\ 扩展前缀（根与 agent 路径任一侧都可能带）", () => {
    expect(absToRel(`\\\\?\\${ROOT}`, "D:\\资料\\我的库\\a.md")).toBe("a.md");
    expect(absToRel(ROOT, "\\\\?\\D:\\资料\\我的库\\a.md")).toBe("a.md");
    expect(absToRel("\\\\?\\UNC\\srv\\share\\lib", "\\\\srv\\share\\lib\\a.md")).toBe("a.md");
  });

  it("UNC 根", () => {
    expect(absToRel("\\\\srv\\share\\lib", "\\\\SRV\\Share\\lib\\docs\\a.md")).toBe("docs/a.md");
    expect(absToRel("\\\\srv\\share\\lib", "\\\\srv\\other\\lib\\a.md")).toBeNull();
    expect(absToRel("\\\\srv\\share\\lib", "\\\\srv\\share\\..\\x.md")).toBeNull();
  });

  it("攻击：根之外 / .. 爬出 / 前缀相似目录 / 别的盘 / 相对路径 / 盘符相对 / NUL / 备用数据流", () => {
    expect(absToRel(ROOT, "C:\\Windows\\win.ini")).toBeNull();
    expect(absToRel(ROOT, "D:\\资料\\我的库\\..\\隔壁\\秘密.md")).toBeNull();
    expect(absToRel(ROOT, "D:\\资料\\我的库\\docs\\..\\..\\越界.md")).toBeNull();
    expect(absToRel(ROOT, "D:\\资料\\我的库外面\\x.md")).toBeNull();
    expect(absToRel(ROOT, "D:\\..\\..\\x.md")).toBeNull();
    expect(absToRel(ROOT, "docs\\a.md")).toBeNull();
    expect(absToRel(ROOT, "D:docs\\a.md")).toBeNull();
    expect(absToRel(ROOT, "\\资料\\我的库\\a.md")).toBeNull();
    expect(absToRel(ROOT, "/资料/我的库/a.md")).toBeNull();
    expect(absToRel(ROOT, "D:\\资料\\我的库\\a\0.md")).toBeNull();
    expect(absToRel(ROOT, "D:\\资料\\我的库\\a.md:secret")).toBeNull();
    expect(absToRel(ROOT, "\\\\.\\D:\\资料\\我的库\\a.md")).toBeNull();
  });

  it("根本身、根尾分隔符、盘符根", () => {
    expect(absToRel(ROOT, ROOT)).toBeNull();
    expect(absToRel(ROOT, `${ROOT}\\`)).toBeNull();
    expect(absToRel(`${ROOT}\\`, `${ROOT}\\a.md`)).toBe("a.md");
    expect(absToRel("D:\\", "D:\\a.md")).toBe("a.md");
    expect(absToRel("D:\\", "D:\\")).toBeNull();
  });

  it("POSIX 根的行为不变（Windows 形态的路径一律拒绝）", () => {
    const posix = "/Users/me/我的资料";
    expect(absToRel(posix, `${posix}/docs/a.md`)).toBe("docs/a.md");
    expect(absToRel(posix, "D:\\Users\\me\\我的资料\\a.md")).toBeNull();
    expect(absToRel(posix, `${posix}/a\\..\\..\\b`)).toBe("a\\..\\..\\b"); // POSIX 上反斜杠是普通字符
  });
});

describe("sliceLines —— CRLF 文件", () => {
  const text = "一\r\n二\r\n三\r\n四";
  it("从中间截断不留孤立的 \\r，内部换行原样", () => {
    expect(sliceLines(text, 2, 2)).toBe("二\r\n三");
    expect(sliceLines(text, null, 1)).toBe("一");
  });
  it("截到文末与全量读取不变", () => {
    expect(sliceLines(text, 3)).toBe("三\r\n四");
    expect(sliceLines(text)).toBe(text);
    expect(sliceLines("一\r\n二\r\n", 1, 2)).toBe("一\r\n二");
  });
});

describe("plainPath / isWindowsAbsPath", () => {
  it("剥扩展前缀，其它原样", () => {
    expect(plainPath("\\\\?\\D:\\lib")).toBe("D:\\lib");
    expect(plainPath("\\\\?\\UNC\\srv\\share\\lib")).toBe("\\\\srv\\share\\lib");
    expect(plainPath("D:\\lib")).toBe("D:\\lib");
    expect(plainPath("/Users/me/lib")).toBe("/Users/me/lib");
  });

  it("识别盘符 / UNC 绝对路径", () => {
    expect(isWindowsAbsPath("D:\\x")).toBe(true);
    expect(isWindowsAbsPath("d:/x")).toBe(true);
    expect(isWindowsAbsPath("\\\\srv\\share")).toBe(true);
    expect(isWindowsAbsPath("\\\\?\\D:\\x")).toBe(true);
    expect(isWindowsAbsPath("/Users/k")).toBe(false);
    expect(isWindowsAbsPath("D:x")).toBe(false);
    expect(isWindowsAbsPath("\\x")).toBe(false);
  });
});
