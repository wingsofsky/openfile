/**
 * 侧栏宽度拖动手柄：骑在栏的内侧边线上的一条 7px 热区。
 * - 指针捕获（setPointerCapture）：拖过 HTML/PDF 的 iframe 也不会丢事件；
 * - 拖动中不加任何过渡（宽度跟手），松手才写 localStorage；
 * - 键盘可达：聚焦后 ←/→ 每次 16px，双击 / Enter 回默认宽度；焦点环可见（美学契约）。
 */
import { useRef, useState } from "react";
import { PANEL_WIDTH, useApp } from "../state/store";
import { t } from "../i18n";

export function PanelResizer({ which }: { which: "rail" | "agent" }) {
  const width = useApp((s) => (which === "rail" ? s.railWidth : s.agentWidth));
  const setPanelWidth = useApp((s) => s.setPanelWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [active, setActive] = useState(false);
  // 文库栏往右拖变宽；会话栏在右侧，往左拖变宽
  const sign = which === "rail" ? 1 : -1;
  const { def, min, max } = PANEL_WIDTH[which];
  const label = which === "rail" ? t("调整文库栏宽度") : t("调整会话栏宽度");

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      title={t("拖动调整宽度，双击恢复默认")}
      tabIndex={0}
      className={`group absolute top-0 z-30 flex h-full w-[7px] cursor-col-resize touch-none justify-center ${
        which === "rail" ? "-right-1" : "-left-1"
      }`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        setPanelWidth(which, drag.current.w + sign * (e.clientX - drag.current.x), false);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = null;
        setActive(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
        setPanelWidth(which, useApp.getState()[which === "rail" ? "railWidth" : "agentWidth"]);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setActive(false);
      }}
      onDoubleClick={() => setPanelWidth(which, def)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setPanelWidth(which, width - sign * 16);
        else if (e.key === "ArrowRight") setPanelWidth(which, width + sign * 16);
        else if (e.key === "Enter") setPanelWidth(which, def);
        else return;
        e.preventDefault();
      }}
    >
      <span
        aria-hidden
        className={`h-full w-px ${active ? "bg-accent-cool" : "bg-transparent group-hover:bg-accent-cool group-focus-visible:bg-accent-cool"}`}
      />
    </div>
  );
}
