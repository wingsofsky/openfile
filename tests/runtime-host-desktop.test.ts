// @vitest-environment node
/** 桌面宿主（Rust）才用到的运行时方法——启动恢复文库、会话命令按登记表解析。 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Host, knownCommand } from "../packages/runtime/src/api/host";
import { programInFolder } from "../packages/runtime/src/api/processes";
import { tempDir } from "./helpers/paths";

let appData: string;
let savedAppData: string | undefined;
let savedGrokBin: string | undefined;
const hosts: Host[] = [];

beforeEach(() => {
  appData = tempDir("of-host-app-");
  savedAppData = process.env.OPENFILE_APPDATA;
  savedGrokBin = process.env.OPENFILE_GROK_BIN;
  process.env.OPENFILE_APPDATA = appData; // 影子仓库落在临时目录
  delete process.env.OPENFILE_GROK_BIN;
});

afterEach(() => {
  for (const h of hosts.splice(0)) h.shutdown();
  if (savedAppData === undefined) delete process.env.OPENFILE_APPDATA;
  else process.env.OPENFILE_APPDATA = savedAppData;
  if (savedGrokBin !== undefined) process.env.OPENFILE_GROK_BIN = savedGrokBin;
});

function host(settingsFile: string | null) {
  const h = new Host({ settingsFile, cliEntry: "unused", appData, emit: () => {} });
  hosts.push(h);
  return h;
}

describe("library.restore", () => {
  it("打开 settings 里上次的文库，不改最近列表；没有或不在了给 null", async () => {
    const lib = tempDir("of-host-lib-");
    const settings = path.join(tempDir("of-host-cfg-"), "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ library: lib, recents: [lib] }));
    const h = host(settings);
    const info = (await h.call("library.restore", { ws: "main" })) as { root: string };
    expect(info.root).toBe(lib);
    expect(h.rootOf("main")).toBe(lib);
    expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toEqual({ library: lib, recents: [lib] });

    fs.writeFileSync(settings, JSON.stringify({ library: path.join(lib, "不存在") }));
    expect(await host(settings).call("library.restore", { ws: "main" })).toBeNull();
    expect(await host(null).call("library.restore", { ws: "main" })).toBeNull();
  });
});

describe("library.open 的设置记录", () => {
  it("主窗口记成上次的文库；别的窗口只进最近列表", async () => {
    const a = tempDir("of-host-a-");
    const b = tempDir("of-host-b-");
    const settings = path.join(tempDir("of-host-cfg-"), "settings.json");
    const h = host(settings);
    await h.call("library.open", { ws: "main", path: a });
    await h.call("library.open", { ws: "lib-1", path: b });
    const v = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(v.library).toBe(a);
    expect(v.recents).toEqual([b, a]);
  });
});

describe("knownCommand", () => {
  it("登记表里的裸名字按登记表解析（环境变量覆盖优先），其余交回通用解析", () => {
    const dir = tempDir("of-host-known-");
    const fake = path.join(dir, process.platform === "win32" ? "grok-fake.exe" : "grok-fake");
    fs.writeFileSync(fake, "");
    fs.chmodSync(fake, 0o755);
    process.env.OPENFILE_GROK_BIN = fake;
    expect(knownCommand("grok")).toBe(fake);
    expect(knownCommand("GROK")).toBe(fake);
    expect(knownCommand("npx")).toBeNull();
    expect(knownCommand("./grok")).toBeNull();
    expect(knownCommand("bin\\grok")).toBeNull();
    expect(knownCommand("")).toBeNull();
  });

  it("打开的文件夹里的同名程序不会被当成预设拉起（Windows 找程序先看 cwd）", async () => {
    const lib = tempDir("of-host-planted-");
    fs.writeFileSync(path.join(lib, "of-planted-cmd.exe"), "");
    expect(programInFolder("of-planted-cmd", lib, "win32")).toBe(path.join(lib, "of-planted-cmd.exe"));
    expect(programInFolder("OF-PLANTED-CMD.exe", lib, "win32")).not.toBeNull();
    expect(programInFolder("of-planted-cmd", lib, "darwin")).toBeNull();
    expect(programInFolder(path.join(lib, "of-planted-cmd.exe"), lib, "win32")).toBeNull();
    expect(programInFolder("other-cmd", lib, "win32")).toBeNull();
    // 走真实的 proc.spawnAgent：PATH 上没有这个命令时，Windows 上拒绝，不从文件夹里拉起
    const h = host(null);
    await h.call("library.open", { ws: "main", path: lib, persist: false });
    const launch = h.call("proc.spawnAgent", { ws: "main", pid: "p1", cmd: "of-planted-cmd", args: [], expectedRoot: lib });
    if (process.platform === "win32") await expect(launch).rejects.toThrow(/同名程序/);
    else {
      await launch.catch(() => {});
      await h.call("proc.kill", { ws: "main", pid: "p1" }).catch(() => {});
    }
  });
});
