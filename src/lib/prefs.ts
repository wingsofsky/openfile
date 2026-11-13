/** 本机界面偏好（localStorage）。测试环境、受限 WebView、隐私模式下读不到就当没有，写不进就只管本次。 */
export const prefs = {
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      /* 只管本次 */
    }
  },
};
