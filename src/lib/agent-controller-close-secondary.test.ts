/** 多窗口：只有主窗口收起 / 留后台；别的窗口关掉就销毁（macOS 上也一样）。 */
import { describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  return {
    close: null as null | ((event: { preventDefault(): void }) => Promise<void>),
    destroy: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    invoke: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  label: "lib-1",
  onCloseRequested: async (handler: typeof h.close) => { h.close = handler; return () => { h.close = null; }; },
  destroy: h.destroy,
  hide: h.hide,
}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./background", () => ({ getBackgroundStatus: async () => ({ profile: { enabled: true } }) }));
vi.mock("./backend", () => ({ backend: { kind: "tauri", writeText: async () => undefined } }));
import "./agent-controller";

describe("secondary window close", () => {
  it("destroys instead of hiding", async () => {
    await vi.waitFor(() => expect(h.close).not.toBeNull());
    const preventDefault = vi.fn();
    await h.close!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(h.destroy).toHaveBeenCalledOnce();
    expect(h.hide).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalledWith("hide_main_window");
  });
});
