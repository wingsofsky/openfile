/** Normal desktop close must await persistence; a failed write keeps the window open. */
import { describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  close: null as null | ((event: { preventDefault(): void }) => Promise<void>),
  fail: true,
  hide: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  write: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  label: "main",
  onCloseRequested: async (handler: typeof h.close) => { h.close = handler; return () => { h.close = null; }; },
  destroy: h.destroy,
  hide: h.hide,
}) }));
vi.mock("./backend", () => ({ backend: {
  kind: "tauri",
  spawnAgent: async () => { throw new Error("test adapter unavailable"); },
  archiveInLibrary: async () => true,
  writeText: async (...args: unknown[]) => { h.write(...args); if (h.fail) throw new Error("disk unavailable"); },
} }));
import { useApp } from "../state/store";
import { useAgent } from "../state/agent";
import { flushSessionArchive, startSession } from "./agent-controller";
import { setLocale } from "../i18n";

describe("desktop close persistence", () => {
  setLocale("zh"); // 断言按中文文案写；默认语言随运行机器的 navigator.language
  it("holds the window on failure, warns browser unload while dirty, then closes only after successful retry", async () => {
    useApp.setState({ lib: { root: "/close-test", name: "test" } });
    useAgent.setState({ presetId: "claude" });
    await startSession();
    expect(await flushSessionArchive()).toBe(false);
    await vi.waitFor(() => expect(h.close).not.toBeNull());
    const preventDefault = vi.fn();
    await h.close!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(h.destroy).not.toHaveBeenCalled();
    expect(useAgent.getState().archive?.status).toBe("error");
    expect(useAgent.getState().panelOpen).toBe(true);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    h.fail = false;
    h.destroy.mockRejectedValueOnce(new Error("permission denied"));
    await h.close!({ preventDefault });
    expect(useAgent.getState().archive?.status).toBe("saved");
    expect(useAgent.getState().error).toContain("无法关闭窗口");
    await h.close!({ preventDefault });
    expect(h.destroy).toHaveBeenCalledTimes(2);
  });
});
