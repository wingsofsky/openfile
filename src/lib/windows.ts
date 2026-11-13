/**
 * 多窗口：每个窗口一个文库、一套会话进程，运行时按窗口 label 分开。
 * 只有桌面端有；浏览器开发模式只有一个窗口。
 */
import { backend } from "./backend";

export const canOpenWindows = backend.kind === "tauri";

/** 在新窗口里打开文库；path 省略时弹系统对话框。返回是否开了窗口（对话框取消为 false） */
export async function openLibraryWindow(path?: string): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("open_library_window", { path });
}
