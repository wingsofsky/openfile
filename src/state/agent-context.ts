/**
 * 会话自动带上当前打开的文件：每条消息都附一段引用，只有库内路径、不含全文，界面上不显示、不用点。
 * 当前文件夹不用附：会话的工作目录就是文库根。活动标签不是文件（对比页、试验场）或没打开文件时，什么都不附。
 */
import { useApp } from "./store";
import { documentReference, formatDocumentContext } from "../lib/document-context";

export function currentFileContext(root: string): { text: string; sources: string[] } | null {
  const app = useApp.getState();
  if (app.lib?.root !== root) return null;
  const tab = app.tabs.find((t) => t.id === app.activeId);
  if (!tab || tab.kind !== "file") return null;
  return { text: formatDocumentContext(documentReference(root, tab.rel)), sources: [tab.rel] };
}
