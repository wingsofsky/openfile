/** MCP server：启动参数、工具分组、影子仓库句柄：模块级状态，加载时求值。 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { canonicalRoot } from "../lib/scoped.mjs";
import {
  ShadowGit,
  appDataDir,
  findShadowDir,
  hasGit,
  hashRustStr,
  initShadowAt,
  sanitizeName,
} from "./shadow.ts";
import { runtimeVersion } from "../version.ts";
import { ALL_TOOL_GROUPS, type ToolGroup } from "./tool-policy.ts";


/* ------------------------------------------------------------------ */
/* 启动参数                                                             */
/* ------------------------------------------------------------------ */

function resolveRoot(): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--root");
  const raw = i !== -1 ? argv[i + 1] : process.env.OPENFILE_LIBRARY;
  if (!raw) {
    console.error("用法: openfile mcp --root <文库目录>（或设 OPENFILE_LIBRARY）");
    process.exit(1);
  }
  let real: string;
  try {
    real = canonicalRoot(path.resolve(raw));
  } catch {
    console.error(`文库目录不可访问: ${raw}`);
    process.exit(1);
  }
  if (!fs.statSync(real).isDirectory()) {
    console.error(`不是目录: ${real}`);
    process.exit(1);
  }
  return real;
}

export const ROOT = resolveRoot();

/* ------------------------------------------------------------------ */
/* 启动选项                                                             */
/* ------------------------------------------------------------------ */

interface Opts {
  /** 启用的工具分组（--tools）：没传时全开（见 tool-policy.ts） */
  tools: Set<ToolGroup>;
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = { tools: new Set(ALL_TOOL_GROUPS) };
  const die = (msg: string): never => {
    console.error(`[openfile-mcp] ${msg}`);
    process.exit(1);
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--root") i++;
    else if (k === "--") continue; // pnpm 在 Windows 上会把分隔符原样传进来
    else if (k === "--tools") {
      const v = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const bad = v.filter((g) => g !== "all" && !(ALL_TOOL_GROUPS as string[]).includes(g));
      if (!v.length || bad.length) die(`--tools 接受逗号分隔的分组：${ALL_TOOL_GROUPS.join(", ")}，或 all${bad.length ? `（不认识：${bad.join(", ")}）` : ""}`);
      o.tools = new Set(v.includes("all") ? ALL_TOOL_GROUPS : (v as ToolGroup[]));
    } else die(`未知参数: ${k}`);
  }
  return o;
}

/** MCP 握手里的 serverInfo.version：启动时读 @openfile/runtime 的 package.json（源码直跑与构建产物同一口径） */
export const OPENFILE_VERSION: string = runtimeVersion();
export const OPTS = parseOpts(process.argv.slice(2));

/* ------------------------------------------------------------------ */
/* 影子仓库（懒初始化，git 缺失时版本工具优雅降级）                        */
/* ------------------------------------------------------------------ */

interface ShadowHandle {
  sg: ShadowGit | null;
  kind: "app" | "dev" | "new" | "none";
  reason?: string;
}

let shadowP: Promise<ShadowHandle> | null = null;
export function shadow(): Promise<ShadowHandle> {
  shadowP ??= (async (): Promise<ShadowHandle> => {
    if (!(await hasGit())) return { sg: null, kind: "none", reason: "系统 PATH 无 git，版本工具不可用" };
    const found = findShadowDir(ROOT);
    if (found) return { sg: new ShadowGit(found.dir, ROOT), kind: found.kind };
    const dir = path.join(
      appDataDir(),
      "shadow",
      `${sanitizeName(path.basename(ROOT))}-${hashRustStr(ROOT)}`,
    );
    try {
      await initShadowAt(dir, ROOT);
      return { sg: new ShadowGit(dir, ROOT), kind: "new" };
    } catch (e) {
      return { sg: null, kind: "none", reason: `影子仓库初始化失败: ${String(e)}` };
    }
  })();
  return shadowP;
}
