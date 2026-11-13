/**
 * 会话预设里原生命令的可执行文件解析（JS 侧唯一实现）：解释登记表 `packages/protocol/src/executor-registry.json`
 * 的发现规则、PATH 查找与解析顺序。运行时宿主拉起侧栏对话时用它解析预设里的裸命令名（如 `grok`）；
 * `tests/fixtures/agent-discovery.json` 钉住发现规则。
 *
 * 解析顺序：环境变量覆盖（bin.env，如 OPENFILE_GROK_BIN）> PATH（加登记表 searchPath 的平台目录）> 发现规则。
 * 打开的文件夹里的配置不参与：文件夹可能是别人的仓库，不能由它决定启动哪个程序。Windows 的 PATH 只认 .exe：
 * .cmd/.bat 垫片不算，npm 放在 .cmd 旁边给 Git Bash 用的无后缀 sh 垫片也不算（按无后缀命中会 spawn 出 ENOENT）；
 * 名字本身带 .exe 时按原名找。环境变量覆盖的值照用，不验存在。
 */
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REGISTRY, ruleApplies } from "@openfile/protocol/executor-registry";

/**
 * @typedef {object} DiscoverCtx
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [platform]
 * @property {string} [home] 用户主目录（缺省 os.homedir()）
 * @property {Pick<typeof nodeFs, "readdirSync" | "statSync">} [fs]
 */

const ctxOf = (/** @type {DiscoverCtx} */ c = {}) => ({
  env: c.env ?? process.env,
  platform: c.platform ?? process.platform,
  home: c.home ?? os.homedir(),
  fs: c.fs ?? nodeFs,
});

const statOk = (fsImpl, p) => {
  try {
    return fsImpl.statSync(p);
  } catch {
    return null;
  }
};
const isFileWith = (fsImpl, p) => !!statOk(fsImpl, p)?.isFile();
const readdir = (fsImpl, p) => {
  try {
    return fsImpl.readdirSync(p).map(String);
  } catch {
    return [];
  }
};

/** 发现规则里的路径 → 本机绝对路径（`~/`、`%LOCALAPPDATA%`、`%APPDATA%`、`{exe}`；分隔符写 `/`） */
export function expandPath(p, ctx = {}) {
  const c = ctxOf(ctx);
  const s = p.replaceAll("{exe}", c.platform === "win32" ? ".exe" : "");
  const segs = (rest) => rest.split("/").filter(Boolean);
  if (s === "~" || s.startsWith("~/")) return path.join(c.home, ...segs(s.slice(1)));
  const m = /^%(LOCALAPPDATA|APPDATA)%(\/.*)?$/.exec(s);
  if (m) {
    const base = c.env[m[1]] ?? path.join(c.home, "AppData", m[1] === "APPDATA" ? "Roaming" : "Local");
    return path.join(base, ...segs(m[2] ?? ""));
  }
  return s.startsWith("/") ? path.join("/", ...segs(s)) : path.join(...segs(s));
}

/** 版本号目录名降序（2.1.260 > 2.1.9；缺的段按 0） */
function sortVersionsDesc(dirs) {
  const num = (v) => v.split(".").map((x) => Number(x));
  return [...dirs].sort((a, b) => {
    const x = num(a);
    const y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
}

/** 具名 pick 规则：base 目录下按规则列出候选（不验存在，由调用方过滤） */
const PICK = {
  "claude-version": (fsImpl, base, then) => {
    const out = [];
    for (const d of sortVersionsDesc(readdir(fsImpl, base).filter((d) => /^[0-9]+([.][0-9]+)*$/.test(d)))) {
      out.push(path.join(base, d, ...then));
      for (const sub of readdir(fsImpl, path.join(base, d)).sort()) out.push(path.join(base, d, sub, ...then));
    }
    return out;
  },
  newest: (fsImpl, base, then) => {
    const hits = [];
    for (const d of readdir(fsImpl, base)) {
      const p = path.join(base, d, ...then);
      const st = statOk(fsImpl, p);
      if (st) hits.push({ p, t: st.mtimeMs });
    }
    return hits.sort((a, b) => b.t - a.t).map((h) => h.p);
  },
};

/** 一组发现规则 → 候选路径（按规则顺序；pick 规则展开成多条；不验存在） */
export function discoverCandidates(rules = [], ctx = {}) {
  const c = ctxOf(ctx);
  const out = [];
  for (const r of rules) {
    if (!ruleApplies(r, c.platform)) continue;
    const p = expandPath(r.path, c);
    if (!r.pick) out.push(p);
    else out.push(...PICK[r.pick](c.fs, p, r.then.split("/").filter(Boolean)));
  }
  return out;
}

/**
 * PATH 目录（环境变量 PATH / Path / path）加登记表 searchPath 里本平台的目录。
 * OPENFILE_SEARCH_PATH 设了（哪怕是空串）就整个替换 searchPath：装在别处的人可以补目录，测试用空串隔离本机安装。
 */
function searchDirs(ctx = {}) {
  const c = ctxOf(ctx);
  const raw = c.env.PATH ?? c.env.Path ?? c.env.path ?? "";
  const custom = c.env.OPENFILE_SEARCH_PATH;
  const extra = custom !== undefined
    ? custom.split(path.delimiter).filter(Boolean).map((d) => expandPath(d, c))
    : REGISTRY.searchPath.filter((r) => ruleApplies(r, c.platform)).map((r) => expandPath(r.path, c));
  return [...raw.split(path.delimiter).filter(Boolean), ...extra];
}

/** PATH 查找（见头注释：Windows 只认 .exe） */
export function whichOnPath(name, env = process.env, platform = process.platform, ctx = {}) {
  const c = ctxOf({ ...ctx, env, platform });
  const exts = platform !== "win32" ? [""] : /\.exe$/i.test(name) ? [""] : [".exe"];
  for (const d of searchDirs(c)) {
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      if (isFileWith(c.fs, p)) return p;
    }
  }
  return null;
}

/**
 * 登记表条目（有 bin 的）按解析顺序找可执行文件；找不到返回 null
 * @param {import("@openfile/protocol/executor-registry").RegistryEntry | undefined} entry
 * @param {DiscoverCtx} [ctx]
 * @returns {string | null}
 */
export function resolveEntryBin(entry, ctx = {}) {
  const c = ctxOf(ctx);
  if (!entry?.bin) return null;
  const override = entry.bin.env ? c.env[entry.bin.env] : null;
  if (override) return override;
  for (const n of entry.bin.names) {
    const hit = whichOnPath(n, c.env, c.platform, c);
    if (hit) return hit;
  }
  for (const p of discoverCandidates(entry.bin.discover, c)) if (isFileWith(c.fs, p)) return p;
  return null;
}

/** 有可执行文件规则的预设：id 与 PATH 上的候选名（不含扩展名），按登记表顺序 */
export const AGENT_CLIS = REGISTRY.executors
  .filter((e) => e.bin)
  .map((e) => ({ id: e.id, label: e.label, binNames: e.bin.names }));
