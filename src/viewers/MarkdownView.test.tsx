// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { createElement, useLayoutEffect } from "react";
import { MarkdownView } from "./MarkdownView";
import { backend } from "../lib/backend";

const DOC = "# 标题\n\n第一段正文。\n\n第二段\\\n硬换行之后。\n";

vi.mock("../lib/backend", () => ({
  backend: {
    kind: "dev",
    readText: vi.fn(() => Promise.resolve({ content: DOC, size: DOC.length, truncated: false, encoding: "utf-8" })),
    writeText: vi.fn(() => Promise.resolve()),
    getUserName: vi.fn(() => Promise.resolve("tester")),
    fileUrl: (r: string) => `http://bridge/${r}`,
  },
}));

// jsdom 没有 Range 的几何接口；批注条只拿它定位
Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 20, right: 40, width: 40, height: 20, x: 0, y: 0, toJSON() {} }) as DOMRect;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

/** 写盘有防抖、卸载时还会补写：按内容找，不按调用顺序取最后一次 */
const written = () => vi.mocked(backend.writeText).mock.calls.map((c) => String(c[1]));
beforeEach(() => vi.mocked(backend.writeText).mockClear());

const textNode = (root: HTMLElement, text: string) => {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent?.includes(text)) return n;
  return null;
};

describe("审阅模式：正文节点不随界面状态重建", () => {
  it("弹出批注条后，原来选中的文字节点还在（选区不会丢）", async () => {
    const { container } = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
    await waitFor(() => expect(textNode(container, "第一段正文")).not.toBeNull());
    const before = textNode(container, "第一段正文")!;
    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(before, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const body = container.querySelector("article")!.closest(".relative")!;
    await act(async () => {
      body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() => expect(container.querySelector(".absolute input")).not.toBeNull());
    // 组件表每次渲染都换新函数时，这一块会被卸掉重建，节点就不是原来那个了
    expect(textNode(container, "第一段正文")).toBe(before);
    expect(before.isConnected).toBe(true);
  });

  it("硬换行的审阅稿能打开，换行后那一行也能落光标", async () => {
    const { container } = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
    await waitFor(() => expect(textNode(container, "硬换行之后")).not.toBeNull());
    const node = textNode(container, "硬换行之后")!;
    expect((node.parentElement as HTMLElement).dataset.o).toBeDefined();
  });

  it.each(["改文字节点", "插新文字节点"])("输入法组合（%s）：撤回浏览器的 DOM 改动，不重挂，修订落在光标处", async (how) => {
    const { container } = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
    await waitFor(() => expect(textNode(container, "第一段正文")).not.toBeNull());
    const art = container.querySelector("article")!;
    const t = textNode(container, "第一段正文") as Text;
    const span = t.parentElement!;
    const sel = window.getSelection()!;
    const at = document.createRange();
    at.setStart(t, 3);
    at.collapse(true);
    sel.removeAllRanges();
    sel.addRange(at);
    await act(async () => {
      art.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      // 浏览器在组合期间直接改 DOM（这里两种改法都模拟）
      if (how === "改文字节点") t.insertData(3, "插入");
      else span.insertBefore(document.createTextNode("插入"), t.splitText(3));
      art.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "插入" }));
      await new Promise((r) => setTimeout(r, 20));
    });
    // 原来的 span 没被卸掉重挂（重挂会让 WebKit 把光标甩到段尾）
    expect(span.isConnected).toBe(true);
    await waitFor(() => expect(written()).toContainEqual(expect.stringMatching(/第一段\{\+\+@[^:]+: 插入\+\+\}正文。/)), { timeout: 2000 });
  });

  it("审阅模式打字记成修订", async () => {
    const want = /第一段\{\+\+@[^:]+: 改\+\+\}正文。/;
    const { container } = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
    await waitFor(() => expect(textNode(container, "第一段正文")).not.toBeNull());
    const art = container.querySelector("article")!;
    const t = textNode(container, "第一段正文") as Text;
    const at = document.createRange();
    at.setStart(t, 3);
    at.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(at);
    await act(async () => {
      art.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "改" }));
    });
    await waitFor(() => expect(written()).toContainEqual(expect.stringMatching(want)), { timeout: 2000 });
  });

  it("正文变成可编辑的那次提交里，输入事件已经被接管", async () => {
    let art: HTMLElement | null = null;
    let taken: boolean | null = null;
    // 父组件的 layout effect 在子组件的 layout effect 之后、所有 passive effect 之前：此刻正文已可编辑，passive effect 还没跑
    const Host = ({ review }: { review: boolean }) => {
      useLayoutEffect(() => {
        if (!review) return;
        const e = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "formatBold" });
        art!.dispatchEvent(e);
        taken = e.defaultPrevented;
      }, [review]);
      return createElement(MarkdownView, { rel: "doc.md", review });
    };
    const { container, rerender, unmount } = render(createElement(Host, { review: false }));
    await waitFor(() => expect(textNode(container, "第一段正文")).not.toBeNull());
    art = container.querySelector("article");
    rerender(createElement(Host, { review: true }));
    expect(art!.getAttribute("contenteditable")).toBe("true");
    expect(taken).toBe(true);
    unmount();
  });
});

describe("逐字源码映射：打字落在源码的正确位置", () => {
  /** 打开一篇稿子，在含 text 的文字节点第 offset 个字处打一个字 */
  async function typeIn(doc: string, text: string, offset: number, data: string) {
    vi.mocked(backend.readText).mockResolvedValue({ content: doc, size: doc.length, truncated: false, encoding: "utf-8" } as never);
    const { container, unmount } = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
    await waitFor(() => expect(textNode(container, text)).not.toBeNull());
    const t = textNode(container, text) as Text;
    const at = document.createRange();
    at.setStart(t, offset);
    at.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(at);
    await act(async () => {
      container.querySelector("article")!.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data }));
    });
    return unmount;
  }
  const want = (re: RegExp) => waitFor(() => expect(written()).toContainEqual(expect.stringMatching(re)), { timeout: 2000 });

  it("列表续行（续行有缩进）", async () => {
    const done = await typeIn("- 列表项一行\n  续行缩进的第二行\n", "续行缩进", 2, "改");
    await want(/^- 列表项一行\n {2}续行\{\+\+@[^:]+: 改\+\+\}缩进的第二行\n$/);
    done();
  });

  it("光标在字符引用转出来的字后面", async () => {
    const done = await typeIn("**加粗。**&#x4F60;好的\n", "你", 1, "们");
    await want(/^\*\*加粗。\*\*&#x4F60;\{\+\+@[^:]+: 们\+\+\}好的\n$/);
    done();
  });

  it("BOM 文件：不错一位，写回时补上读取时剥掉的 BOM", async () => {
    // 真实读取会剥掉 BOM、size 仍按文件字节算（多 3 个字节）
    vi.mocked(backend.readText).mockResolvedValue({ content: "哈哈哈\n", size: 3 + new TextEncoder().encode("哈哈哈\n").length, truncated: false, encoding: "utf-8" } as never);
    const { container, unmount } = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
    await waitFor(() => expect(textNode(container, "哈哈哈")).not.toBeNull());
    const t = textNode(container, "哈哈哈") as Text;
    const at = document.createRange();
    at.setStart(t, 1);
    at.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(at);
    await act(async () => {
      container.querySelector("article")!.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "改" }));
    });
    await want(/^\uFEFF哈\{\+\+@[^:]+: 改\+\+\}哈哈\n$/);
    unmount();
    // 内容里本身带着 BOM（不经剥离的读法）也不错位：渲染前剥掉、起点后挪一位
    const done = await typeIn("\uFEFF哈哈哈\n", "哈哈哈", 1, "改");
    await want(/^\uFEFF哈\{\+\+@[^:]+: 改\+\+\}哈哈\n$/);
    done();
  });

  /** 打开一篇稿子，把选区设到 [start 节点含 sText 的第 sOff 字, end 节点含 eText 的第 eOff 字]，发一个输入事件 */
  async function inputOn(doc: string, sel: [string, number, string, number], inputType: string, data: string | null = null) {
    vi.mocked(backend.readText).mockResolvedValue({ content: doc, size: doc.length, truncated: false, encoding: "utf-8" } as never);
    const { container, unmount } = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
    await waitFor(() => expect(textNode(container, sel[0])).not.toBeNull());
    const r = document.createRange();
    r.setStart(textNode(container, sel[0])!, sel[1]);
    r.setEnd(textNode(container, sel[2])!, sel[3]);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    await act(async () => {
      container.querySelector("article")!.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data }));
    });
    return unmount;
  }

  it("退格删转义出来的字：整个记号包进删除", async () => {
    const done = await inputOn("**加粗。**&#x4F60;好的\n", ["你", 1, "你", 1], "deleteContentBackward");
    await want(/^\*\*加粗。\*\*\{--@[^:]+: &#x4F60;--\}好的\n$/);
    done();
  });

  it("光标紧跟在加粗后面退格：删的是加粗里最后那个字，不是星号", async () => {
    const done = await inputOn("**加粗。** 好的\n", [" 好的", 0, " 好的", 0], "deleteContentBackward");
    await want(/^\*\*加粗\{--@[^:]+: 。--\}\*\* 好的\n$/);
    done();
  });

  it("选区跨过加粗与实体：拆成两条删除，格式符号留着", async () => {
    const done = await inputOn("**加粗。**&#x4F60;好的\n", ["加粗。", 1, "好的", 1], "deleteContentBackward");
    await want(/^\*\*加\{--@[^:]+: 粗。--\}\*\*\{--@[^:]+: &#x4F60;好--\}的\n$/);
    done();
  });

  it("选中跨格式的一段直接打字：第一段成替换、其余删除", async () => {
    const done = await inputOn("**加粗。**&#x4F60;好的\n", ["加粗。", 1, "好的", 1], "insertText", "换");
    await want(/^\*\*加\{~~@[^:]+: 粗。~>换~~\}\*\*\{--@[^:]+: &#x4F60;好--\}的\n$/);
    done();
  });

  it("CRLF 文件", async () => {
    const done = await typeIn("第一行\r\n第二行\r\n", "第二行", 1, "改");
    await want(/^第一行\r\n第\{\+\+@[^:]+: 改\+\+\}二行\r\n$/);
    done();
  });

  describe("贴着标记打字", () => {
    it("删除文字末尾：字落在标记后", async () => {
      const done = await typeIn("前{--@bob: 旧文--}后\n", "旧文", 2, "新");
      await want(/^前\{--@bob: 旧文--\}\{\+\+@[^:]+: 新\+\+\}后\n$/);
      done();
    });

    it("整段都是删除，段尾打字", async () => {
      const done = await typeIn("{--@bob: 整段--}\n\n下一段\n", "整段", 2, "新");
      await want(/^\{--@bob: 整段--\}\{\+\+@[^:]+: 新\+\+\}\n\n下一段\n$/);
      done();
    });

    it("别人插入的中间：拆开", async () => {
      const done = await typeIn("前{++@bob: 新文++}后\n", "新文", 1, "我");
      await want(/^前\{\+\+@bob: 新\+\+\}\{\+\+@[^:]+: 我\+\+\}\{\+\+@bob: 文\+\+\}后\n$/);
      done();
    });

    it("光标落在批注气泡里：字落在气泡后", async () => {
      const done = await typeIn("前{>>@bob: 批注<<}后\n", "批注", 2, "新");
      await want(/^前\{>>@bob: 批注<<\}\{\+\+@[^:]+: 新\+\+\}后\n$/);
      done();
    });

    it("光标落在【给 agent 的话】里：字落在它后面", async () => {
      const done = await typeIn("前【说明】后\n", "说明", 4, "新");
      await want(/^前【说明】\{\+\+@[^:]+: 新\+\+\}后\n$/);
      done();
    });
  });

  describe("换行", () => {
    const at = (text: string, off: number): [string, number, string, number] => [text, off, text, off];

    it("Enter：分段记成一条插入", async () => {
      const done = await inputOn("甲乙\n", at("甲乙", 1), "insertParagraph");
      await want(/^甲\{\+\+@[^:]+: \n\n\+\+\}乙\n$/);
      done();
    });

    it("Shift+Enter：软换行", async () => {
      const done = await inputOn("甲乙\n", at("甲乙", 1), "insertLineBreak");
      await want(/^甲\{\+\+@[^:]+: \n\+\+\}乙\n$/);
      done();
    });

    it("列表项：新项", async () => {
      const done = await inputOn("- 项一\n- 项二\n", at("项一", 2), "insertParagraph");
      await want(/^- 项一\{\+\+@[^:]+: \n- \+\+\}\n- 项二\n$/);
      done();
    });

    it("加粗尾巴：挪到星号外面", async () => {
      const done = await inputOn("**粗**\n\n下一段\n", at("粗", 1), "insertParagraph");
      await want(/^\*\*粗\*\*\{\+\+@[^:]+: \n\n\+\+\}\n\n下一段\n$/);
      done();
    });

    it("加粗中间、表格里：提示，不写盘", async () => {
      const a = await inputOn("**加粗**\n", at("加粗", 1), "insertParagraph");
      await waitFor(() => expect(document.body.textContent).toContain("Can't start a paragraph inside bold text or a link"));
      a();
      const b = await inputOn("| 头 |\n|---|\n| 单元 |\n", at("单元", 1), "insertParagraph");
      await waitFor(() => expect(document.body.textContent).toContain("Table cells can't take line breaks"));
      b();
      expect(written()).toEqual([]);
    });

    it("选中一段再按 Enter：替换成分段", async () => {
      const done = await inputOn("甲乙丙\n", ["甲乙丙", 1, "甲乙丙", 2], "insertParagraph");
      await want(/^甲\{~~@[^:]+: 乙~>\n\n~~\}丙\n$/);
      done();
    });

    it("多行粘贴：换行进修订，列表里补缩进", async () => {
      const done = await inputOn("- 甲乙\n", at("甲乙", 1), "insertText", "一\n\n二");
      await want(/^- 甲\{\+\+@[^:]+: 一\n\n {2}二\+\+\}乙\n$/);
      done();
    });

    it("段首退格：记成对分段的删除；前面是代码块则提示", async () => {
      const a = await inputOn("甲\n\n乙\n", at("乙", 0), "deleteContentBackward");
      await want(/^甲\{--@[^:]+: \n\n--\}乙\n$/);
      a();
      vi.mocked(backend.writeText).mockClear();
      const b = await inputOn("```\n码\n```\n\n乙\n", at("乙", 0), "deleteContentBackward");
      await waitFor(() => expect(document.body.textContent).toContain("Can't merge here"));
      b();
      expect(written()).toEqual([]);
    });

    it("新空段落有落脚点：光标放上去能打字，退格撤掉回车", async () => {
      const doc = "甲{++@tester: \n\n++}\n\n乙\n";
      vi.mocked(backend.readText).mockResolvedValue({ content: doc, size: doc.length, truncated: false, encoding: "utf-8" } as never);
      const { container, unmount } = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
      await waitFor(() => expect(container.querySelector("[data-anchor]")).not.toBeNull());
      // 作者名异步读到后才算「自己」
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      const r0 = document.createRange();
      r0.setStart(container.querySelector("[data-anchor]")!, 0);
      r0.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(r0);
      await act(async () => {
        container.querySelector("article")!.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward", data: null }));
      });
      await want(/^甲\n\n乙\n$/);
      unmount();
      vi.mocked(backend.writeText).mockClear();
      const again = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
      await waitFor(() => expect(again.container.querySelector("[data-anchor]")).not.toBeNull());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      const r = document.createRange();
      r.setStart(again.container.querySelector("[data-anchor]")!, 0);
      r.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(r);
      await act(async () => {
        again.container.querySelector("article")!.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "新" }));
      });
      await want(/^甲\{\+\+@tester: \n\n新\+\+\}\n\n乙\n$/);
      again.unmount();
    });

    it("段尾向前删：合并下一段", async () => {
      const done = await inputOn("甲\n\n乙\n", at("甲", 1), "deleteContentForward");
      await want(/^甲\{--@[^:]+: \n\n--\}乙\n$/);
      done();
    });
  });

  describe("输入法组合", () => {
    /** 打开稿子，光标放到 place() 给的位置，模拟一次组合（浏览器在组合期间直接改 DOM） */
    async function compose(doc: string, place: (c: HTMLElement) => [Node, number], mutate: (n: Node, off: number) => void, data: string) {
      vi.mocked(backend.readText).mockResolvedValue({ content: doc, size: doc.length, truncated: false, encoding: "utf-8" } as never);
      const { container, unmount } = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
      await waitFor(() => expect(container.querySelector("[data-o]")).not.toBeNull());
      const [node, off] = place(container);
      const r = document.createRange();
      r.setStart(node, off);
      r.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(r);
      const art = container.querySelector("article")!;
      await act(async () => {
        art.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        mutate(node, off);
        art.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data }));
        await new Promise((res) => setTimeout(res, 20));
      });
      return { unmount, container };
    }

    it("删除文字末尾：字落在标记后，删除文字原样", async () => {
      const { unmount, container } = await compose(
        "前{--@bob: 旧文--}后\n",
        (c) => [textNode(c, "旧文")!, 2],
        (n) => (n as Text).appendData("拼音"),
        "汉字",
      );
      await want(/^前\{--@bob: 旧文--\}\{\+\+@[^:]+: 汉字\+\+\}后\n$/);
      await waitFor(() => expect(textNode(container, "拼音")).toBeNull());
      unmount();
    });

    it("光标停在删除文字边上就挪到旁边正文；输入法按键和组合期间不动选区", async () => {
      vi.mocked(backend.readText).mockResolvedValue({ content: "前{--@bob: 旧文--}后\n", size: 18, truncated: false, encoding: "utf-8" } as never);
      const { container, unmount } = render(createElement(MarkdownView, { rel: "doc.md", review: true }));
      await waitFor(() => expect(textNode(container, "旧文")).not.toBeNull());
      const art = container.querySelector("article")!;
      const sel = window.getSelection()!;
      const putAtDelEnd = () => {
        const r = document.createRange();
        r.setStart(textNode(container, "旧文")!, 2);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      };
      // 第一个键就是输入法键：按键这一刻不能再动选区（会打断组合，第一个字母上屏成英文）
      putAtDelEnd();
      art.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Process" }));
      expect(sel.anchorNode?.textContent).toBe("旧文");
      // 组合进行中：不动
      art.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
      expect(sel.anchorNode?.textContent).toBe("旧文");
      await act(async () => {
        art.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
        await new Promise((res) => setTimeout(res, 20));
      });
      // 光标停下：挪到删除标记后面那段正文的开头，页面上是同一处
      putAtDelEnd();
      document.dispatchEvent(new Event("selectionchange"));
      expect(sel.anchorNode?.textContent).toBe("后");
      expect(sel.anchorOffset).toBe(0);
      unmount();
    });

    it("新空段落的落脚点：浏览器插进的文字被撤回，字进修订", async () => {
      const { unmount, container } = await compose(
        "甲{++@me: \n\n++}\n\n乙\n",
        (c) => [c.querySelector("[data-anchor]")!, 0],
        (n) => n.insertBefore(document.createTextNode("拼音"), n.firstChild),
        "汉字",
      );
      await want(/^甲\{\+\+@me: \n\n\+\+\}\{\+\+@[^:]+: 汉字\+\+\}\n\n乙\n$|^甲\{\+\+@me: \n\n汉字\+\+\}\n\n乙\n$/);
      await waitFor(() => expect(textNode(container, "拼音")).toBeNull());
      unmount();
    });
  });
});

