/**
 * 会话预设登记表内核：`executor-registry.json` 是侧栏对话的 ACP 预设、以及预设里原生命令怎么在本机找到的**唯一定义处**；
 * 本模块给它类型、在加载时校验，并导出预设列表。
 *
 * 谁读这份 JSON：
 *   - 界面：会话面板的预设下拉（`ACP_PRESETS`）；
 *   - JS 运行时：`packages/runtime/src/lib/agent-registry.mjs` 把预设里的裸命令名（如 `grok`）解析成可执行文件。
 *
 * 发现规则（`bin.discover`，只有 agent-registry.mjs 一份解释，`tests/fixtures/agent-discovery.json` 钉住它）：
 *   `{ os?, path, pick?, then? }`。path 里 `~/` = 用户主目录，`%LOCALAPPDATA%` / `%APPDATA%` 取环境变量（缺省主目录下的
 *   AppData/Local、AppData/Roaming），`{exe}` 在 Windows 是 `.exe`、其它平台为空；分隔符一律写 `/`。
 *   没有 pick 时 path 就是候选文件；有 pick 时 path 是目录，按具名规则列子目录再拼 then：
 *     - `claude-version`：纯数字点分的版本目录，版本号降序；每个版本先列 `<版本>/<then>`，再列 `<版本>/<子目录>/<then>`（2026-10 起多一层构建哈希目录）
 *     - `newest`：每个子目录下的 then，按它的修改时间降序（ChatGPT 桌面版内嵌的 codex）
 *   解析顺序：环境变量覆盖（bin.env）> PATH（加 searchPath 的平台目录；Windows 只认 .exe）> discover。打开的文件夹不参与。
 *
 * 纯 TS、零依赖、无 IO（protocol 包约定）。
 */
import data from "./executor-registry.json" with { type: "json" };

export const PLATFORMS = ["win32", "darwin", "linux"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PICKS = ["claude-version", "newest"] as const;
export type DiscoverPick = (typeof PICKS)[number];

export interface DiscoverRule {
  os?: Platform[];
  path: string;
  pick?: DiscoverPick;
  then?: string;
}

export interface PathRule {
  os?: Platform[];
  path: string;
}

export interface BinSpec {
  /** 环境变量覆盖可执行文件路径 */
  env?: string;
  /** PATH 上的候选名（不含扩展名） */
  names: string[];
  discover?: DiscoverRule[];
}

export interface AcpPreset {
  command: string;
  args: string[];
  note?: string;
}

export interface RegistryEntry {
  id: string;
  label: string;
  bin?: BinSpec;
  acp: AcpPreset;
}

export interface Registry {
  version: number;
  searchPath: PathRule[];
  executors: RegistryEntry[];
}

/* ------------------------------------------------------------------ */
/* 校验（加载时跑一遍；坏表直接抛错，不静默）                              */
/* ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => isStr(v) && (list as readonly string[]).includes(v);
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function validatePlatforms(where: string, v: unknown): Platform[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => oneOf(PLATFORMS, x))) throw new Error(`${where}.os 只接受 ${PLATFORMS.join(" | ")} 的数组`);
  return v as Platform[];
}

function validateEntry(e: unknown): RegistryEntry {
  if (!isObj(e) || !isStr(e.id) || !ID_RE.test(e.id)) throw new Error(`登记表条目缺 id 或 id 非法：${JSON.stringify(e)}`);
  const w = `登记表 ${e.id}`;
  if (!isStr(e.label)) throw new Error(`${w} 缺 label`);
  if (e.bin !== undefined) {
    const b = e.bin;
    if (!isObj(b) || !isStrArr(b.names) || (b.env !== undefined && !isStr(b.env))) throw new Error(`${w}.bin 需要 names 数组（env 可选）`);
    for (const [i, r] of ((b.discover as unknown[]) ?? []).entries()) {
      if (!isObj(r) || !isStr(r.path)) throw new Error(`${w}.bin.discover[${i}] 缺 path`);
      validatePlatforms(`${w}.bin.discover[${i}]`, r.os);
      if (r.pick !== undefined && !oneOf(PICKS, r.pick)) throw new Error(`${w}.bin.discover[${i}].pick 只接受 ${PICKS.join(" | ")}`);
      if (r.pick !== undefined && !isStr(r.then)) throw new Error(`${w}.bin.discover[${i}] 有 pick 就要有 then`);
    }
  }
  if (!isObj(e.acp) || !isStr(e.acp.command) || !isStrArr(e.acp.args)) throw new Error(`${w}.acp 需要 command 与 args`);
  return e as unknown as RegistryEntry;
}

/** 校验整张表（导出给测试用；模块加载时对内置 JSON 跑一遍） */
export function validateRegistry(raw: unknown): Registry {
  if (!isObj(raw) || !Array.isArray(raw.executors)) throw new Error("登记表缺 executors");
  const executors = raw.executors.map(validateEntry);
  const ids = new Set<string>();
  for (const e of executors) {
    if (ids.has(e.id)) throw new Error(`登记表 id 重复：${e.id}`);
    ids.add(e.id);
  }
  const searchPath = ((raw.searchPath as unknown[]) ?? []).map((r, i) => {
    if (!isObj(r) || !isStr(r.path)) throw new Error(`登记表 searchPath[${i}] 缺 path`);
    return { path: r.path, ...(r.os !== undefined ? { os: validatePlatforms(`searchPath[${i}]`, r.os) } : {}) };
  });
  return { version: Number(raw.version ?? 1), searchPath, executors };
}

export const REGISTRY: Registry = validateRegistry(data);

export const registryEntry = (id: string): RegistryEntry | undefined => REGISTRY.executors.find((e) => e.id === id);

/** 条目按平台能不能用这条规则 */
export const ruleApplies = (r: { os?: Platform[] }, platform: string): boolean => !r.os || (r.os as string[]).includes(platform);

/** 会话面板的预设，按登记表顺序，id 与登记表一致 */
export const ACP_PRESETS: ReadonlyArray<{ id: string; label: string; cmd: string; args: string[]; note?: string }> = REGISTRY.executors.map((e) => ({
  id: e.id,
  label: e.label,
  cmd: e.acp.command,
  args: [...e.acp.args],
  ...(e.acp.note ? { note: e.acp.note } : {}),
}));
