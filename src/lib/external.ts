/** 外链统一出口：Tauri 走 opener 插件（系统浏览器），dev 直接新标签页 */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return; // 只放行 http(s)
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
