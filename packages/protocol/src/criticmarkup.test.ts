import { describe, expect, it } from "vitest";
import {
  applyAll,
  applySegment,
  codeRanges,
  countCritic,
  makeCritic,
  parseCritic,
} from "./criticmarkup.ts";

describe("parseCritic", () => {
  it("解析五种标记与偏移", () => {
    const src = "前{++插入++}中{--删除--}后{~~旧~>新~~}尾{>>批注<<}末{==高亮==}。";
    const segs = parseCritic(src);
    expect(segs.map((s) => s.kind)).toEqual(["ins", "del", "sub", "comment", "mark"]);
    // 偏移精确：用偏移切出的原文必须等于完整标记
    for (const s of segs) {
      expect(src.slice(s.start, s.end).startsWith("{")).toBe(true);
      expect(src.slice(s.start, s.end).endsWith("}")).toBe(true);
    }
    const sub = segs[2];
    expect(sub.old).toBe("旧");
    expect(sub.newText).toBe("新");
  });

  it("作者扩展：@名字: 前缀（中英冒号均可）", () => {
    const segs = parseCritic("{++@claude: 建议的新句++}{>>@alice：这里逻辑断了<<}");
    expect(segs[0].author).toBe("claude");
    expect(segs[0].text).toBe("建议的新句");
    expect(segs[1].author).toBe("alice");
    expect(segs[1].text).toBe("这里逻辑断了");
  });

  it("跨行标记可解析", () => {
    const segs = parseCritic("{++第一行\n第二行++}");
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("第一行\n第二行");
  });

  it("代码围栏内的标记是字面量", () => {
    const src = "正文{++真++}\n```\n{--这是示例不是删除--}\n```\n{++又一个真++}";
    const segs = parseCritic(src);
    expect(segs.map((s) => s.text)).toEqual(["真", "又一个真"]);
  });

  it("行内代码中的标记是字面量", () => {
    const segs = parseCritic("语法是 `{++x++}` 这样，而{++这个是真的++}。");
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("这个是真的");
  });

  it("四反引号围栏内含三反引号仍整体屏蔽", () => {
    const src = "````\n```\n{--围栏内--}\n```\n````\n{++围栏外++}";
    const segs = parseCritic(src);
    expect(segs.map((s) => s.text)).toEqual(["围栏外"]);
  });

  it("未闭合标记与缺箭头替换不误判", () => {
    expect(parseCritic("{++没有闭合")).toHaveLength(0);
    expect(parseCritic("{~~没有箭头~~}")).toHaveLength(0);
  });
});

describe("applySegment / applyAll", () => {
  const src = "他{--慢慢地--}走了{++，头也不回++}。{~~黄昏~>暮色~~}降临。{>>@alice: 结尾太仓促<<}";

  it("接受：删除生效、插入保留、替换用新文", () => {
    expect(applyAll(src, true)).toBe("他走了，头也不回。暮色降临。");
  });

  it("拒绝：删除还原、插入丢弃、替换保旧文", () => {
    expect(applyAll(src, false)).toBe("他慢慢地走了。黄昏降临。");
  });

  it("单个标记应用不影响其它标记的文本", () => {
    const segs = parseCritic(src);
    const afterOne = applySegment(src, segs[0], true); // 接受删除
    expect(afterOne).toContain("{++，头也不回++}");
    expect(afterOne).not.toContain("慢慢地");
    // 再解析剩余标记数
    expect(parseCritic(afterOne)).toHaveLength(3);
  });

  it("批注解决即移除；高亮去壳保内文", () => {
    expect(applyAll("A{>>x<<}B{==重点==}C", true)).toBe("AB重点C");
    expect(applyAll("A{>>x<<}B{==重点==}C", false)).toBe("AB重点C");
  });
});

describe("countCritic", () => {
  it("统计与 actionable", () => {
    const c = countCritic("{++a++}{--b--}{~~c~>d~~}{>>e<<}{==f==}");
    expect(c).toMatchObject({ ins: 1, del: 1, sub: 1, comment: 1, mark: 1, total: 5, actionable: 4 });
  });
});

describe("makeCritic", () => {
  it("构造可被解析回读（往返）", () => {
    const s =
      makeCritic.ins("新增", "claude") +
      makeCritic.del("多余") +
      makeCritic.sub("旧", "新", "alice") +
      makeCritic.comment("疑问？", "alice");
    const segs = parseCritic(s);
    expect(segs).toHaveLength(4);
    expect(segs[0].author).toBe("claude");
    expect(segs[2].old).toBe("旧");
    expect(segs[2].newText).toBe("新");
  });
});

describe("codeRanges", () => {
  it("围栏与行内代码区间", () => {
    const src = "a `x` b\n```\ncode\n```\nc";
    const r = codeRanges(src);
    expect(r.length).toBeGreaterThanOrEqual(2);
  });
});
