// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "..");
// 不存在的绝对路径当 cwd：不落在临时目录里，git 根探测也拿不到，按「项目层」分组
const proj = (name) => (process.platform === "win32" ? `Z:\\${name}\\sub` : `/Volumes/X/${name}/sub`);

let tmp, home, root, sessions;
const codexFile = (name) => path.join(sessions, `${name}.jsonl`);
const writeCodex = (name, id, cwd, msgs) => {
  const recs = [{ type: "session_meta", timestamp: "2026-10-01T08:00:00Z", payload: { id, cwd } }];
  msgs.forEach(([role, text], i) =>
    recs.push({
      type: "response_item",
      timestamp: `2026-10-01T08:0${Math.min(i + 1, 9)}:00Z`,
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    }),
  );
  fs.writeFileSync(codexFile(name), recs.map((r) => JSON.stringify(r)).join("\n"));
};
const run = (...args) =>
  execFileSync(process.execPath, ["scripts/session-import.mjs", "--root", root, "--source", "codex", "--all-projects", ...args], {
    cwd: repo,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
const archives = () =>
  fs
    .readdirSync(path.join(root, "会话/导入"), { recursive: true })
    .map((p) => p.replaceAll("\\", "/"))
    .filter((p) => p.endsWith(".md") && !p.endsWith("索引.md"))
    .sort();
const read = (rel) => fs.readFileSync(path.join(root, "会话/导入", rel), "utf8");

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openfile-archive-")));
  home = path.join(tmp, "home");
  root = path.join(tmp, "library");
  sessions = path.join(home, ".codex", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("会话归档：按项目分目录、续写刷新、不丢字", () => {
  it("新会话按项目落子目录；索引两级，会话行的链接指进项目子目录", () => {
    writeCodex("a", "id-a", proj("alpha"), [["user", "ALPHA 第一问"], ["assistant", "答一"]]);
    writeCodex("b", "id-b", proj("beta"), [["user", "BETA 第一问"], ["assistant", "答"]]);
    run();
    const files = archives();
    expect(files.filter((f) => f.startsWith("alpha/"))).toHaveLength(1);
    expect(files.filter((f) => f.startsWith("beta/"))).toHaveLength(1);
    const index = fs.readFileSync(path.join(root, "会话/导入/索引.md"), "utf8");
    expect(index).toContain("| [alpha](alpha/索引.md) | 1 |");
    // 会话行：七列，第三列是档案链接（项目行只有两列）
    const links = index.split("\n")
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
      .filter((cells) => cells.length >= 7)
      .map((cells) => /^\[.*\]\((.*)\)$/.exec(cells[2])?.[1])
      .filter(Boolean);
    expect(links).toHaveLength(2);
    expect(links.every((href) => /^(alpha|beta)\//.test(href))).toBe(true);
    expect(fs.existsSync(path.join(root, "会话/导入/alpha/索引.md"))).toBe(true);
    expect(read(files.find((f) => f.startsWith("alpha/")))).toMatch(/^- 校验: sha256:[0-9a-f]{16}$/m);
  });

  it("会话导入后又继续：原地刷新；档案被人改过就不覆盖并列出来；再跑一遍什么都不做", () => {
    writeCodex("a", "id-a", proj("alpha"), [["user", "第一问"], ["assistant", "答一"]]);
    writeCodex("b", "id-b", proj("beta"), [["user", "B 第一问"], ["assistant", "B 答"]]);
    run();
    const [aRel, bRel] = [archives().find((f) => f.startsWith("alpha/")), archives().find((f) => f.startsWith("beta/"))];
    fs.appendFileSync(path.join(root, "会话/导入", bRel), "\n{>>我的批注<<}\n");
    writeCodex("a", "id-a", proj("alpha"), [["user", "第一问"], ["assistant", "答一"], ["user", "第二问"], ["assistant", "答二"]]);
    writeCodex("b", "id-b", proj("beta"), [["user", "B 第一问"], ["assistant", "B 答"], ["user", "B 第二问"]]);
    const out = run();
    expect(out).toContain(`已刷新: 会话/导入/${aRel}（2 → 4 轮）`);
    expect(out).toMatch(/1 份档案导入后被改过/);
    expect(archives()).toEqual([aRel, bRel].sort());
    expect(read(aRel)).toContain("第二问");
    expect(read(bRel)).toContain("我的批注");
    expect(read(bRel)).not.toContain("B 第二问");
    expect(run()).toMatch(/完成：导入 0，刷新 0/);
  });

  it("codex：同一会话 id 的分叉线程各存一份；rollout 挪进 archived_sessions 不重复导入", () => {
    writeCodex("main", "same-id", proj("alpha"), [["user", "主线问题"], ["assistant", "主线回答"]]);
    writeCodex("fork", "same-id", proj("alpha"), [["user", "分叉问题"], ["assistant", "分叉回答"]]);
    run();
    expect(archives()).toHaveLength(2);
    const archived = path.join(home, ".codex", "archived_sessions");
    fs.mkdirSync(archived, { recursive: true });
    fs.renameSync(codexFile("main"), path.join(archived, "main.jsonl"));
    run();
    expect(archives()).toHaveLength(2);
  });

  it("前文对不上但原始记录更多：以原始记录为准，旧档挪到 _旧版/ 留底", () => {
    writeCodex("a", "id-a", proj("alpha"), [["user", "第一问"], ["assistant", "答一"]]);
    run();
    const rel = archives()[0];
    // 模拟上游改写了记录：开头那句变了，同时多了两轮
    writeCodex("a", "id-a", proj("alpha"), [["user", "被改写的第一问"], ["assistant", "答一"], ["user", "第二问"], ["assistant", "答二"]]);
    const out = run();
    expect(out).toMatch(/1 份会话的原始记录被上游改写过/);
    const files = archives();
    expect(files).toContain(rel);
    const old = files.find((f) => f.includes("/_旧版/"));
    expect(old).toBeTruthy();
    expect(read(old)).toContain("第一问");
    expect(read(rel)).toContain("被改写的第一问");
  });

  it("--reorganize：平铺的档案按头部「项目」归入子目录；原始转写已删的只搬家不改内容", () => {
    const flat = [
      "# 会话：平铺档案",
      "",
      "- 来源: codex · id `gone-1`",
      `- 项目: ${proj("gamma")}`,
      "- 时间: 2026-09-01 10:00 → 2026-09-01 10:05 · 轮次: 1 用户 / 1 助手 · 工具 0 次 · 派发 0 次",
      `- 导入: 2026-09-01 10:06 · 原始转写: \`${path.join(home, "gone.jsonl")}\``,
      "",
      "---",
      "",
      "## 用户",
      "",
      "早就删掉的会话",
      "",
    ].join("\n");
    fs.mkdirSync(path.join(root, "会话/导入"), { recursive: true });
    fs.writeFileSync(path.join(root, "会话/导入/20260901-1000-gone1-平铺档案.md"), flat);
    writeCodex("a", "id-a", proj("alpha"), [["user", "第一问"], ["assistant", "答一"]]);
    run();
    const out = run("--reorganize");
    expect(out).toMatch(/整理完成：2 份档案/);
    expect(archives()).toContain("gamma/20260901-1000-gone1-平铺档案.md");
    expect(read("gamma/20260901-1000-gone1-平铺档案.md")).toBe(flat);
    expect(fs.readdirSync(path.join(root, "会话/导入")).filter((n) => n.endsWith(".md"))).toEqual(["索引.md"]);
  });
});
