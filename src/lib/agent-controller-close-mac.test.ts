/** macOS: the red close button hides the window; the app and its session stay alive. */
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
  label: "main",
  onCloseRequested: async (handler: typeof h.close) => { h.close = handler; return () => { h.close = null; }; },
  destroy: h.destroy,
  hide: h.hide,
}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./backend", () => ({ backend: { kind: "tauri", writeText: async () => undefined } }));
import "./agent-controller";

describe("macOS close", () => {
  it("hides instead of destroying", async () => {
    await vi.waitFor(() => expect(h.close).not.toBeNull());
    const preventDefault = vi.fn();
    await h.close!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(h.invoke).toHaveBeenCalledWith("hide_main_window");
    expect(h.hide).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
  });
});
