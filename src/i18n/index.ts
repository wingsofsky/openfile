/**
 * 界面文案的最小国际化：
 *   - 键就是中文原文：`t("本机 agent")`。中文界面零成本（原样返回），英文从 en.ts 的字典查，查不到回退中文。
 *   - 带变量用位置占位：`t("剩 {0}%", [n])`；命名占位 `t("{n} 个任务", { n })`。
 *   - 英文单复数写在 en.ts 的值里：`{0|file|files}` 在变量 0 等于 1 时取前一个词，否则取后一个（中文没有单复数，键里不写）。
 *   - 语言存 localStorage（openfile.locale），首次按浏览器语言；切换时 App 用 key={locale} 整棵重挂，组件不用订阅。
 * 不引入库；字典由 scripts/i18n-extract.mjs 从源码抽键、由译者（grok）填英文。
 * 注意：目录名（会话 / 内嵌 / 导入）、文件名和 CriticMarkup 标记是数据格式，不是文案，只翻译它们的显示名。
 */
import { en } from "./en";
import { prefs } from "../lib/prefs";

type Locale = "zh" | "en";
/** 状态栏语言开关上显示的是「另一种语言」的名字，不经 t()（"中" 会和思考档位的「中」撞键） */
export const LOCALE_TOGGLE_LABEL: Record<Locale, string> = { zh: "EN", en: "中" };
const STORAGE_KEY = "openfile.locale";

function detect(): Locale {
  const saved = prefs.get(STORAGE_KEY);
  if (saved === "zh" || saved === "en") return saved;
  try {
    return typeof navigator !== "undefined" && /^en\b/i.test(navigator.language) ? "en" : "zh";
  } catch {
    return "zh";
  }
}

let current: Locale = detect();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(l: Locale): void {
  if (l === current) return;
  current = l;
  prefs.set(STORAGE_KEY, l);
  for (const fn of listeners) fn();
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

type Vars = ReadonlyArray<string | number> | Readonly<Record<string, string | number>>;

function fill(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g, (m, k: string, one?: string, many?: string) => {
    const v = Array.isArray(vars) ? (vars as ReadonlyArray<string | number>)[Number(k)] : (vars as Record<string, string | number>)[k];
    if (v === undefined || v === null) return m;
    return one === undefined ? String(v) : Number(v) === 1 ? one : many!;
  });
}

/** 文案：键为中文原文；英文缺译时回退中文（并在开发模式记一次） */
export function t(key: string, vars?: Vars): string {
  if (current === "zh") return fill(key, vars);
  const hit = (en as Record<string, string>)[key];
  if (hit === undefined && import.meta.env.DEV && !missing.has(key)) {
    missing.add(key);
    console.warn(`[i18n] 缺英文: ${key}`);
  }
  return fill(hit ?? key, vars);
}

const missing = new Set<string>();
