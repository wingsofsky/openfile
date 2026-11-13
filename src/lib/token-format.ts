/**
 * 会话面板的用量显示：令牌数缩写、上下文占用百分比。纯函数、零 IO。
 */

/** 令牌数缩写：1.23M / 45.6k / 999 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 上下文占用百分比（0–100，越界夹住）；size 无效时返回 null */
export function contextPercent(used: number, size: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0 || used < 0) return null;
  return Math.min(100, Math.round((used / size) * 100));
}
