import { Component, type ReactNode } from "react";
import { t } from "../i18n";

/**
 * 视图错误边界：任何 viewer 抛错时显示可读的错误卡片，而不是 React
 * 卸载整棵子树留下的白屏。错误详情直接可见，报障时能说清是哪里坏了。
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="min-h-0 overflow-y-auto px-8 py-10">
          <p className="font-sans text-[14px] text-accent-warm">
            {t("这个视图崩溃了。下面是错误详情（截图发给开发者即可定位）：")}
          </p>
          <pre className="mt-3 overflow-x-auto rounded-[3px] border border-rule bg-panel p-3 font-mono text-[12.5px] leading-relaxed text-muted">
            {String(error.stack || error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
