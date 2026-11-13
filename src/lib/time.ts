/** epoch 秒 → 中文相对时间（时间线用） */
export function formatRelTime(epochSecs: number, now = Date.now()): string {
  const d = new Date(epochSecs * 1000);
  const diff = Math.max(0, Math.floor(now / 1000) - epochSecs);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (isSameDay(d, today)) return `今天 ${hm}`;
  const yesterday = new Date(now - 86400_000);
  if (isSameDay(d, yesterday)) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`;
}
