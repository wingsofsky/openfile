// @vitest-environment node
/**
 * 文件夹还不是文库时，内嵌会话档案存应用数据目录（packages/runtime/src/lib/session-archive.mjs）。
 * 核心断言：不往打开的文件夹里写；名字与路径攻击在触盘之前被拒、零副作用；链接逃逸与绑定冲突被拒。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLibraryRoot, listSessionArchives, readSessionArchive, writeSessionArchive } from "../packages/runtime/src/lib/session-archive.mjs";
import { folderTargetKey } from "../packages/runtime/src/lib/folder-paths.mjs";
import { Host } from "../packages/runtime/src/api/host";
import { FILE_SYMLINK_SKIP, linkDir, linkFile } from "./helpers/links";
import { tempDir } from "./helpers/paths";

const NAME = "2026-10-21T03-04-05-678Z-0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.md";
const dirs: string[] = [];
const fixture = (prefix: string) => {
  const d = tempDir(prefix);
  dirs.push(d);
  return d;
};
const tree = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));

describe("会话档案的应用数据落点", () => {
  it("按规范库根的键写进应用数据目录，打开的文件夹原样不动", async () => {
    const app = fixture("of-arch-app-"), root = fixture("of-arch-root-");
    fs.writeFileSync(path.join(root, "doc.md"), "正文");
    expect(isLibraryRoot(root)).toBe(false);
    writeSessionArchive(app, root, NAME, "# 第一版\n", null);
    writeSessionArchive(app, root, NAME, "# 第二版\n", "# 第一版\n");
    expect(tree(root)).toEqual(["doc.md"]);
    const dir = path.join(app, "sessions", folderTargetKey(root));
    expect(JSON.parse(fs.readFileSync(path.join(dir, "target.json"), "utf8"))).toEqual({ version: 1, target: root });
    expect(fs.readFileSync(path.join(dir, NAME), "utf8")).toBe("# 第二版\n");
    expect(listSessionArchives(app, root)).toEqual([expect.objectContaining({ name: NAME, size: Buffer.byteLength("# 第二版\n") })]);
    expect((await readSessionArchive(app, root, NAME)).content).toBe("# 第二版\n");

    fs.writeFileSync(path.join(root, ".openfile"), "不是目录");
    expect(isLibraryRoot(root)).toBe(false);
    fs.unlinkSync(path.join(root, ".openfile"));
    fs.mkdirSync(path.join(root, ".openfile"));
    expect(isLibraryRoot(root)).toBe(true);
  });

  it("不覆盖：只新建时已存在、基线对不上都拒绝，原内容不变", () => {
    const app = fixture("of-arch-app-"), root = fixture("of-arch-root-");
    writeSessionArchive(app, root, NAME, "原文", null);
    expect(() => writeSessionArchive(app, root, NAME, "改写", null)).toThrow(/已存在/);
    expect(() => writeSessionArchive(app, root, NAME, "改写", "不是磁盘上的内容")).toThrow(/已更改/);
    expect(() => writeSessionArchive(app, root, NAME, "改写", undefined as unknown as null)).toThrow(/基线/);
    expect(fs.readFileSync(path.join(app, "sessions", folderTargetKey(root), NAME), "utf8")).toBe("原文");
  });

  it("没存过档案：列出为空、读不到，且不建任何目录", () => {
    const app = fixture("of-arch-app-"), root = fixture("of-arch-root-");
    expect(listSessionArchives(app, root)).toEqual([]);
    expect(() => readSessionArchive(app, root, NAME)).toThrow(/不可访问/);
    expect(tree(app)).toEqual([]);
    const missing = path.join(app, "还没建");
    expect(listSessionArchives(missing, root)).toEqual([]);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("只认会话控制器生成的档案名：越界、绝对路径、NUL、分隔符、设备名、短名、大小写变体都在触盘前拒绝", () => {
    const app = fixture("of-arch-app-"), root = fixture("of-arch-root-");
    const bad = [
      "", ".", "..", "../x.md", `../${NAME}`, `sub/${NAME}`, `sub\\${NAME}`, path.join(root, NAME), `/tmp/${NAME}`, `C:\\${NAME}`,
      `C:${NAME}`, `${NAME}\0`, `${NAME} `, `${NAME}.`, `${NAME}:stream`, `${NAME}::$DATA`, "CON.md", "con", "NUL", "target.json",
      "x.md", "2026-1~1.MD", NAME.toUpperCase(), NAME.replace(".md", ".MD"), NAME.replace(".md", ".txt"), NAME.replace("T03", "t03"),
      `${NAME}/`, ` ${NAME}`,
    ];
    for (const name of bad) {
      expect(() => writeSessionArchive(app, root, name, "x", null), JSON.stringify(name)).toThrow(/档案名无效/);
      expect(() => readSessionArchive(app, root, name), JSON.stringify(name)).toThrow(/档案名无效/);
    }
    expect(tree(app)).toEqual([]);
    expect(tree(root)).toEqual([]);
  });

  it("档案目录或 sessions 被链接到应用数据目录之外：拒绝，外面一个文件也不建", () => {
    const root = fixture("of-arch-root-"), outside = fixture("of-arch-out-");
    const app = fixture("of-arch-app-");
    fs.mkdirSync(path.join(app, "sessions"));
    linkDir(outside, path.join(app, "sessions", folderTargetKey(root)));
    expect(() => writeSessionArchive(app, root, NAME, "x", null)).toThrow();
    expect(tree(outside)).toEqual([]);

    const app2 = fixture("of-arch-app-");
    linkDir(outside, path.join(app2, "sessions"));
    expect(() => writeSessionArchive(app2, root, NAME, "x", null)).toThrow();
    expect(tree(outside)).toEqual([]);
    // 外面预先摆好一份「绑定」与档案，也不能借链接读出来
    const planted = path.join(outside, folderTargetKey(root));
    fs.mkdirSync(planted);
    fs.writeFileSync(path.join(planted, "target.json"), JSON.stringify({ version: 1, target: root }));
    fs.writeFileSync(path.join(planted, NAME), "外面的秘密");
    expect(() => listSessionArchives(app2, root)).toThrow();
    expect(() => readSessionArchive(app2, root, NAME)).toThrow();
  });

  it("哈希只是命名空间：目录绑定的是别的库根时拒绝读写", () => {
    const app = fixture("of-arch-app-"), root = fixture("of-arch-root-"), other = fixture("of-arch-other-");
    const dir = path.join(app, "sessions", folderTargetKey(root));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "target.json"), JSON.stringify({ version: 1, target: other }));
    expect(() => writeSessionArchive(app, root, NAME, "x", null)).toThrow(/绑定不一致/);
    expect(() => listSessionArchives(app, root)).toThrow(/绑定不一致/);
    expect(fs.readdirSync(dir)).toEqual(["target.json"]);
  });

  it("只列合格档案名的普通文件：子目录、杂项文件、符号链接都不列", async ({ annotate }) => {
    const app = fixture("of-arch-app-"), root = fixture("of-arch-root-"), outside = fixture("of-arch-out-");
    writeSessionArchive(app, root, NAME, "# 档案\n", null);
    const dir = path.join(app, "sessions", folderTargetKey(root));
    const other = NAME.replace("678Z", "679Z");
    fs.mkdirSync(path.join(dir, other));
    fs.writeFileSync(path.join(dir, "notes.md"), "杂项");
    fs.writeFileSync(path.join(outside, "secret.md"), "外面的秘密");
    const linked = NAME.replace("678Z", "680Z");
    if (linkFile(path.join(outside, "secret.md"), path.join(dir, linked))) {
      await expect(readSessionArchive(app, root, linked)).rejects.toThrow();
    } else void annotate(`file-link listing case not exercised: ${FILE_SYMLINK_SKIP}`, "skip");
    expect(listSessionArchives(app, root).map((f) => f.name)).toEqual([NAME]);
  });
});

describe("宿主 archive.* 方法", () => {
  let saved: string | undefined;
  const hosts: Host[] = [];
  let app: string;
  beforeEach(() => {
    app = fixture("of-arch-host-app-");
    saved = process.env.OPENFILE_APPDATA;
    process.env.OPENFILE_APPDATA = app; // 影子仓库也落在临时目录
  });
  afterEach(() => {
    for (const h of hosts.splice(0)) h.shutdown();
    if (saved === undefined) delete process.env.OPENFILE_APPDATA;
    else process.env.OPENFILE_APPDATA = saved;
  });
  const open = async (root: string) => {
    const h = new Host({ settingsFile: null, cliEntry: "unused", appData: app, emit: () => {} });
    hosts.push(h);
    await h.call("library.open", { ws: "main", path: root, persist: false });
    // 开库时后台建影子仓库；等它建完，否则清理临时目录时 git 还在往里写（ENOTEMPTY）
    await h.workspace("main").shadow().catch(() => {});
    return h;
  };

  it("非文库：档案进应用数据目录、文件夹里不建东西；建了 .openfile/ 就算文库", async () => {
    const root = fixture("of-arch-host-root-");
    const h = await open(root);
    expect(await h.call("archive.inLibrary", { ws: "main", expectedRoot: root })).toBe(false);
    await h.call("archive.write", { ws: "main", expectedRoot: root, name: NAME, content: "# 档案\n", expectedContent: null });
    expect(fs.readdirSync(root)).toEqual([]);
    expect(await h.call("archive.list", { ws: "main", expectedRoot: root })).toEqual([expect.objectContaining({ name: NAME })]);
    expect(((await h.call("archive.read", { ws: "main", expectedRoot: root, name: NAME })) as { content: string }).content).toBe("# 档案\n");
    fs.mkdirSync(path.join(root, ".openfile"));
    expect(await h.call("archive.inLibrary", { ws: "main", expectedRoot: root })).toBe(true);
  });

  it("expectedRoot 与基线都必须给，库已切换时 409，且什么也不写", async () => {
    const root = fixture("of-arch-host-root-"), other = fixture("of-arch-host-other-");
    const h = await open(root);
    await expect(h.call("archive.write", { ws: "main", expectedRoot: other, name: NAME, content: "x", expectedContent: null })).rejects.toMatchObject({ status: 409 });
    await expect(h.call("archive.write", { ws: "main", name: NAME, content: "x", expectedContent: null })).rejects.toMatchObject({ status: 400 });
    await expect(h.call("archive.write", { ws: "main", expectedRoot: root, name: NAME, content: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(h.call("archive.list", { ws: "main", expectedRoot: other })).rejects.toMatchObject({ status: 409 });
    await expect(h.call("archive.inLibrary", { ws: "main" })).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(path.join(app, "sessions"))).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
