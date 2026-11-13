import { describe, expect, it } from "vitest";
import { applyAll, parseCritic } from "@openfile/protocol/criticmarkup";
import { breakText, outOfFormat, pasteText, planEdit, type EditOp } from "./suggest-edit";

const ME = "alice";

function run(full: string, op: EditOp, author = ME) {
  const r = planEdit(full, op, author);
  if (!r.ok) throw new Error(r.error);
  return r;
}

/** 依次打字：每次在上一步的光标处插入一个字 */
function type(full: string, at: number, chars: string) {
  let s = full;
  let c = at;
  for (const ch of chars) {
    const r = run(s, { kind: "insert", at: c, end: c, text: ch });
    s = r.next;
    c = r.caret;
  }
  return { s, c };
}

function backspace(full: string, at: number, times: number) {
  let s = full;
  let c = at;
  for (let i = 0; i < times; i++) {
    const r = run(s, { kind: "delete", at: c, end: c, dir: "back" });
    s = r.next;
    c = r.caret;
  }
  return { s, c };
}

describe("planEdit 插入", () => {
  it("在正文里打字：新开一条署名插入，光标在插入内文末尾", () => {
    const r = run("窗外的雨。", { kind: "insert", at: 3, end: 3, text: "冷" });
    expect(r.next).toBe("窗外的{++@alice: 冷++}雨。");
    expect(r.next.slice(0, r.caret)).toBe("窗外的{++@alice: 冷");
  });

  it("连续打字接在同一条插入上，不新开标记", () => {
    const { s } = type("窗外的雨。", 3, "冷冷的");
    expect(s).toBe("窗外的{++@alice: 冷冷的++}雨。");
  });

  it("光标紧贴自己插入的末尾（标记外侧）也接上去", () => {
    const full = "窗外的{++@alice: 冷++}雨。";
    const r = run(full, { kind: "insert", at: full.indexOf("雨"), end: full.indexOf("雨"), text: "的" });
    expect(r.next).toBe("窗外的{++@alice: 冷的++}雨。");
  });

  it("在自己替换的新文本里打字改新文本", () => {
    const full = "采用{~~@alice: 定性~>混合~~}方法";
    const at = full.indexOf("合") + 1;
    expect(run(full, { kind: "insert", at, end: at, text: "式" }).next).toBe("采用{~~@alice: 定性~>混合式~~}方法");
  });

  it("选中后打字：变替换", () => {
    const r = run("本研究采用定性方法。", { kind: "insert", at: 5, end: 7, text: "混合", rendered: "定性" });
    expect(r.next).toBe("本研究采用{~~@alice: 定性~>混合~~}方法。");
    expect(r.next.slice(r.caret)).toBe("~~}方法。");
  });

  it("选区带格式符号（渲染文字与源码不等）拒绝", () => {
    const full = "这是**很重要**的。";
    const r = planEdit(full, { kind: "insert", at: 2, end: 9, text: "x", rendered: "很重要" }, ME);
    expect(r.ok).toBe(false);
  });

  it("标记定界符拒绝，代码区拒绝", () => {
    expect(planEdit("一段。", { kind: "insert", at: 1, end: 1, text: "a~>b" }, ME).ok).toBe(false);
    const code = "看 `代码` 吧";
    expect(planEdit(code, { kind: "insert", at: 4, end: 4, text: "x" }, ME).ok).toBe(false);
  });

  it("CRLF 文档：插入不碰原有换行", () => {
    const full = "第一行。\r\n\r\n第二行。\r\n";
    const at = full.indexOf("二");
    expect(run(full, { kind: "insert", at, end: at, text: "新" }).next).toBe("第一行。\r\n\r\n第{++@alice: 新++}二行。\r\n");
  });
});

describe("planEdit 删除", () => {
  it("退格删正文：变删除标记，光标停在标记前", () => {
    const r = run("窗外的雨。", { kind: "delete", at: 3, end: 3, dir: "back" });
    expect(r.next).toBe("窗外{--@alice: 的--}雨。");
    expect(r.caret).toBe(2);
  });

  it("连续退格并进同一条删除", () => {
    const { s } = backspace("窗外的雨。", 3, 3);
    expect(s).toBe("{--@alice: 窗外的--}雨。");
  });

  it("连续向前删除也并成一条", () => {
    let s = "窗外的雨。";
    let c = 0;
    for (let i = 0; i < 2; i++) {
      const r = run(s, { kind: "delete", at: c, end: c, dir: "forward" });
      s = r.next;
      c = r.caret;
    }
    expect(s).toBe("{--@alice: 窗外--}的雨。");
  });

  it("退格删自己刚打的字：直接删掉，删空撤掉整条", () => {
    const { s, c } = type("窗外的雨。", 3, "冷冷");
    expect(backspace(s, c, 1).s).toBe("窗外的{++@alice: 冷++}雨。");
    expect(backspace(s, c, 2).s).toBe("窗外的雨。");
    // 再退一格：越过已撤掉的位置删到正文
    expect(backspace(s, c, 3).s).toBe("窗外{--@alice: 的--}雨。");
  });

  it("退格越过已有删除标记与批注", () => {
    const full = "窗外的{--@bob: 雨--}{>>@bob: 嗯<<}。";
    const r = run(full, { kind: "delete", at: full.indexOf("。"), end: full.indexOf("。"), dir: "back" });
    expect(r.next).toBe("窗外{--@alice: 的--}{--@bob: 雨--}{>>@bob: 嗯<<}。");
  });

  it("自己替换的新文本删空：退回成对旧文本的删除", () => {
    const full = "采用{~~@alice: 定性~>混~~}方法";
    const at = full.indexOf("混") + 1;
    expect(run(full, { kind: "delete", at, end: at, dir: "back" }).next).toBe("采用{--@alice: 定性--}方法");
  });

  it("选区删除：整段划线；跨段落拒绝", () => {
    const r = run("我们认为这很重要。", { kind: "delete", at: 0, end: 9, dir: "back", rendered: "我们认为这很重要。" });
    expect(r.next).toBe("{--@alice: 我们认为这很重要。--}");
    expect(planEdit("一。\n\n二。", { kind: "delete", at: 0, end: 5, dir: "back" }, ME).ok).toBe(false);
  });

  it("不合并段落、不删格式符号、到头了给提示", () => {
    expect(planEdit("一。\n\n二。", { kind: "delete", at: 4, end: 4, dir: "back" }, ME).ok).toBe(false);
    expect(planEdit("**粗**", { kind: "delete", at: 2, end: 2, dir: "back" }, ME).ok).toBe(false);
    expect(planEdit("一。", { kind: "delete", at: 0, end: 0, dir: "back" }, ME).ok).toBe(false);
  });

  it("emoji 等代理对整字删除", () => {
    const full = "好😀。";
    expect(run(full, { kind: "delete", at: 3, end: 3, dir: "back" }).next).toBe("好{--@alice: 😀--}。");
  });
});

describe("光标落在任何标记上都能打字", () => {
  const insertAt = (full: string, at: number, text = "X") => run(full, { kind: "insert", at, end: at, text });
  /** 把光标放到 needle 第 k 个字之后 */
  const after = (full: string, needle: string, k = needle.length) => full.indexOf(needle) + k;

  it.each([
    ["别人的删除末尾 → 标记后", "前{--@bob: 旧文--}后", "旧文", 2, "前{--@bob: 旧文--}{++@alice: X++}后"],
    ["自己的删除末尾 → 标记后", "前{--@alice: 旧文--}后", "旧文", 2, "前{--@alice: 旧文--}{++@alice: X++}后"],
    ["删除开头 → 标记前", "前{--@bob: 旧文--}后", "旧文", 0, "前{++@alice: X++}{--@bob: 旧文--}后"],
    ["删除中间 → 拆开", "前{--@bob: 旧文--}后", "旧文", 1, "前{--@bob: 旧--}{++@alice: X++}{--@bob: 文--}后"],
    ["没署名的删除中间 → 拆开", "前{--旧文--}后", "旧文", 1, "前{--旧--}{++@alice: X++}{--文--}后"],
    ["别人的插入末尾 → 标记后", "前{++@bob: 新文++}后", "新文", 2, "前{++@bob: 新文++}{++@alice: X++}后"],
    ["别人的插入中间 → 拆开", "前{++@bob: 新文++}后", "新文", 1, "前{++@bob: 新++}{++@alice: X++}{++@bob: 文++}后"],
    ["高亮中间 → 拆开", "前{==高亮==}后", "高亮", 1, "前{==高==}{++@alice: X++}{==亮==}后"],
    ["别人替换的旧文中间", "前{~~@bob: 旧文~>新文~~}后", "旧文", 1, "前{--@bob: 旧--}{++@alice: X++}{~~@bob: 文~>新文~~}后"],
    ["别人替换的旧文末尾（紧挨新文）", "前{~~@bob: 旧文~>新文~~}后", "旧文", 2, "前{--@bob: 旧文--}{++@alice: X++}{++@bob: 新文++}后"],
    ["别人替换的新文开头（紧挨旧文）", "前{~~@bob: 旧文~>新文~~}后", "新文", 0, "前{--@bob: 旧文--}{++@alice: X++}{++@bob: 新文++}后"],
    ["别人替换的新文中间", "前{~~@bob: 旧文~>新文~~}后", "新文", 1, "前{~~@bob: 旧文~>新~~}{++@alice: X++}{++@bob: 文++}后"],
    ["别人替换的新文末尾 → 标记后", "前{~~@bob: 旧文~>新文~~}后", "新文", 2, "前{~~@bob: 旧文~>新文~~}{++@alice: X++}后"],
    ["自己替换的旧文末尾 → 接到新文开头", "前{~~@alice: 旧文~>新文~~}后", "旧文", 2, "前{~~@alice: 旧文~>X新文~~}后"],
    ["批注里 → 批注后", "前{>>@bob: 批注<<}后", "批注", 1, "前{>>@bob: 批注<<}{++@alice: X++}后"],
  ])("%s", (_name, full, needle, k, want) => {
    expect(insertAt(full, after(full, needle, k)).next).toBe(want);
  });

  it("删除末尾连续打字并成一条，光标跟着走", () => {
    const full = "前{--@alice: 旧文--}后";
    const { s } = type(full, after(full, "旧文"), "新的字");
    expect(s).toBe("前{--@alice: 旧文--}{++@alice: 新的字++}后");
  });

  it("删除末尾紧跟自己的插入：接到那条开头", () => {
    const full = "前{--@alice: 旧--}{++@alice: 新++}后";
    expect(insertAt(full, after(full, "旧")).next).toBe("前{--@alice: 旧--}{++@alice: X新++}后");
  });

  it("中间拆开后接着打字接在新插入上", () => {
    const full = "前{--@bob: 旧文--}后";
    expect(type(full, after(full, "旧文", 1), "XY").s).toBe("前{--@bob: 旧--}{++@alice: XY++}{--@bob: 文--}后");
  });

  it("拆开不变量：全部拒绝等于插入前全部拒绝；全部接受只多了新字", () => {
    const docs = [
      "前{--@bob: 旧文字--}后",
      "前{++@bob: 新文字++}后",
      "前{~~@bob: 旧文字~>新文字~~}后",
      "前{~~@alice: 旧文字~>新文字~~}后",
      "前{==高亮字==}后",
      "前{--@bob: 一段\n\n二段--}后",
      "前{>>@bob: 批注<<}后",
    ];
    for (const full of docs) {
      const seg = parseCritic(full)[0];
      for (let at = seg.start; at <= seg.end; at++) {
        const { next, caret } = insertAt(full, at, "鑫");
        expect(applyAll(next, false)).toBe(applyAll(full, false));
        expect(applyAll(next, true).replace("鑫", "")).toBe(applyAll(full, true));
        expect(next.slice(0, caret).endsWith("鑫")).toBe(true);
      }
    }
  });

  it("代码区里仍然拒绝", () => {
    const code = "看 `{--旧--}` 吧";
    expect(planEdit(code, { kind: "insert", at: 5, end: 5, text: "x" }, ME).ok).toBe(false);
  });
});

describe("换行也是修订", () => {
  const enter = (full: string, at: number, soft = false, inList = false) => {
    const text = breakText(full, at, soft, inList);
    return run(full, { kind: "insert", at, end: at, text });
  };

  it("段落中间回车：一条插入，接受成两段，拒绝还原", () => {
    const r = enter("甲乙", 1);
    expect(r.next).toBe("甲{++@alice: \n\n++}乙");
    expect(applyAll(r.next, true)).toBe("甲\n\n乙");
    expect(applyAll(r.next, false)).toBe("甲乙");
    expect(r.next.slice(r.caret)).toBe("++}乙");
  });

  it("回车后接着打字并进同一条", () => {
    const r = enter("甲乙", 1);
    expect(type(r.next, r.caret, "新").s).toBe("甲{++@alice: \n\n新++}乙");
  });

  it("Shift+Enter 是软换行；标题里也得分段", () => {
    expect(enter("甲乙", 1, true).next).toBe("甲{++@alice: \n++}乙");
    expect(breakText("# 标题", 3, true, false)).toBe("\n\n");
  });

  it("CRLF 文档用 CRLF", () => {
    expect(breakText("甲乙\r\n\r\n丙", 1, false, false)).toBe("\r\n\r\n");
    expect(enter("甲乙\r\n", 1, true).next).toBe("甲{++@alice: \r\n++}乙\r\n");
  });

  it("列表：新项抄记号、序号加一、任务框清空；续行抄缩进", () => {
    expect(breakText("- 项一", 3, false, true)).toBe("\n- ");
    expect(breakText("  * 子项", 5, false, true)).toBe("\n  * ");
    expect(breakText("3. 项", 3, false, true)).toBe("\n4. ");
    expect(breakText("9) 项", 3, false, true)).toBe("\n10) ");
    expect(breakText("- [x] 做完", 6, false, true)).toBe("\n- [ ] ");
    expect(breakText("- 项一", 3, true, true)).toBe("\n  ");
    expect(breakText("1. 项一\n   续行", 8, false, true)).toBe("\n2. ");
  });

  it("引用：段落内分段，软换行只抄前缀；引用里的列表", () => {
    expect(breakText("> 引用", 3, false, false)).toBe("\n>\n> ");
    expect(breakText("> 引用", 3, true, false)).toBe("\n> ");
    expect(breakText("> - 项", 4, false, true)).toBe("\n> - ");
  });

  it("多行粘贴补前缀；空行不留尾随空格", () => {
    expect(pasteText("甲乙", 1, "一\n二", false)).toBe("一\n二");
    expect(pasteText("甲\r\n", 1, "一\n二", false)).toBe("一\r\n二");
    expect(pasteText("- 项", 2, "一\n\n二", true)).toBe("一\n\n  二");
    expect(pasteText("> 引", 2, "一\n\n二", false)).toBe("一\n>\n> 二");
  });

  it("加粗、链接的边上挪到符号外", () => {
    expect(outOfFormat("前**粗**后", 4, "tail")).toBe(6);
    expect(outOfFormat("前**粗**后", 3, "head")).toBe(1);
    expect(outOfFormat("前[链](a.md)后", 3, "tail")).toBe(10);
    expect(outOfFormat("前[链](a.md)后", 2, "head")).toBe(1);
  });

  it("拒绝 / 替换也能带换行", () => {
    const r = run("甲乙丙", { kind: "pieces", pieces: [{ a: 1, b: 2 }], text: "\n\n", dir: "back" });
    expect(r.next).toBe("甲{~~@alice: 乙~>\n\n~~}丙");
  });
});

describe("合并段落（join）", () => {
  const join = (full: string, at: number, dir: "back" | "forward" = "back") => planEdit(full, { kind: "join", at, dir }, ME);
  const next = (full: string, at: number, dir: "back" | "forward" = "back") => {
    const r = join(full, at, dir);
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  it("段首退格：原有分段记成删除，接受才合并", () => {
    const r = next("甲\n\n乙", 3);
    expect(r.next).toBe("甲{--@alice: \n\n--}乙");
    expect(applyAll(r.next, true)).toBe("甲乙");
    expect(applyAll(r.next, false)).toBe("甲\n\n乙");
    expect(r.next.slice(r.caret)).toBe("乙");
  });

  it("段尾向前删：同样的结果", () => {
    expect(next("甲\n\n乙", 1, "forward").next).toBe("甲{--@alice: \n\n--}乙");
  });

  it("撤销自己按的回车：标记撤掉，光标回去", () => {
    const full = "甲{++@alice: \n\n++}乙";
    const r = next(full, full.indexOf("++}"));
    expect(r.next).toBe("甲乙");
    expect(r.caret).toBe(1);
  });

  it("自己的多段插入里合并：只删换行", () => {
    const full = "甲{++@alice: 新\n\n段++}乙";
    expect(next(full, full.indexOf("段")).next).toBe("甲{++@alice: 新段++}乙");
    expect(next(full, full.indexOf("新") + 1, "forward").next).toBe("甲{++@alice: 新段++}乙");
  });

  it("列表项、引用：前缀一起进删除", () => {
    expect(next("- 一\n- 二", 6).next).toBe("- 一{--@alice: \n- --}二");
    expect(next("> 一\n>\n> 二", 9).next).toBe("> 一{--@alice: \n>\n> --}二");
  });

  it("软换行、硬换行记号一起合并", () => {
    expect(next("甲\n乙", 2).next).toBe("甲{--@alice: \n--}乙");
    expect(next("甲\\\n乙", 3).next).toBe("甲{--@alice: \\\n--}乙");
    expect(next("甲  \n乙", 4).next).toBe("甲{--@alice:   \n--}乙");
  });

  it("CRLF", () => {
    expect(next("甲\r\n\r\n乙", 5).next).toBe("甲{--@alice: \r\n\r\n--}乙");
  });

  it("行首有已删除的字：删除标记留在后面", () => {
    const full = "甲\n\n{--@bob: 旧--}乙";
    expect(next(full, full.indexOf("旧")).next).toBe("甲{--@alice: \n\n--}{--@bob: 旧--}乙");
  });

  it("到头了；已标删除、别人的换行不动", () => {
    expect(join("甲", 0).ok).toBe(false);
    expect(join("甲", 1, "forward").ok).toBe(false);
    const del = "甲{--@bob: \n\n--}乙";
    expect(join(del, del.indexOf("乙")).ok).toBe(false);
    const inner = "甲{++@bob: 新\n\n段++}乙";
    expect(join(inner, inner.indexOf("段")).ok).toBe(false);
  });

  it("代码块里不动手", () => {
    expect(join("```\n一\n二\n```", 6).ok).toBe(false);
  });
});

describe("按页面上的字删除 / 替换（pieces）", () => {
  const SRC = "**加粗。**&#x4F60;好的\n";
  const at = (s: string, from = 0) => SRC.indexOf(s, from);
  const ent = { a: at("&#x4F60;"), b: at("&#x4F60;") + 8 };
  const pieces = (...ps: Array<{ a: number; b: number }>): EditOp => ({ kind: "pieces", pieces: ps, text: "", dir: "back" });

  it("转义出来的字整个记号包进删除", () => {
    expect(run(SRC, pieces(ent)).next).toBe("**加粗。**{--@alice: &#x4F60;--}好的\n");
  });

  it("跨加粗与实体的选区拆成几段各包一条，格式符号留着；第一段带上新字成替换", () => {
    const ps = [{ a: at("粗"), b: at("粗") + 2 }, ent, { a: at("好"), b: at("好") + 1 }];
    expect(run(SRC, pieces(...ps)).next).toBe("**加{--@alice: 粗。--}**{--@alice: &#x4F60;好--}的\n");
    expect(run(SRC, { kind: "pieces", pieces: ps, text: "X", dir: "back" }).next).toBe("**加{~~@alice: 粗。~>X~~}**{--@alice: &#x4F60;好--}的\n");
  });

  it("连续退格并进紧邻的自己那条删除；删的是自己的插入就直接改它", () => {
    const once = run(SRC, pieces({ a: at("好"), b: at("好") + 1 })).next;
    expect(run(once, pieces({ a: once.indexOf("&#x4F60;"), b: once.indexOf("&#x4F60;") + 8 })).next).toBe("**加粗。**{--@alice: &#x4F60;好--}的\n");
    const mine = "前{++@alice: 新加的++}后\n";
    expect(run(mine, pieces({ a: mine.indexOf("加"), b: mine.indexOf("加") + 1 })).next).toBe("前{++@alice: 新的++}后\n");
  });

  it("已标删除的字跳过；别人的建议不动手", () => {
    const gone = "前{--@bob: 旧--}后\n";
    const r = planEdit(gone, pieces({ a: gone.indexOf("旧"), b: gone.indexOf("旧") + 1 }, { a: gone.indexOf("后"), b: gone.indexOf("后") + 1 }), ME);
    expect(r.ok && r.next).toBe("前{--@bob: 旧--}{--@alice: 后--}\n");
    const theirs = "前{++@bob: 新++}后\n";
    expect(planEdit(theirs, pieces({ a: theirs.indexOf("新"), b: theirs.indexOf("新") + 1 }), ME).ok).toBe(false);
  });
});
