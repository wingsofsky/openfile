import { describe, expect, it } from "vitest";
import { ACP_PRESETS, REGISTRY, registryEntry, validateRegistry } from "./executor-registry.ts";

describe("会话预设登记表", () => {
  it("内置 JSON 过校验；id 唯一；每条都是会话预设", () => {
    expect(ACP_PRESETS.map((p) => p.id)).toEqual(["codex", "agy", "grok", "claude", "gemini"]);
    expect(new Set(REGISTRY.executors.map((e) => e.id)).size).toBe(REGISTRY.executors.length);
    expect(registryEntry("grok")?.acp).toEqual(expect.objectContaining({ command: "grok", args: ["agent", "stdio"] }));
    expect(registryEntry("grok")?.bin?.names).toEqual(["grok"]);
    expect(registryEntry("gemini")?.bin).toBeUndefined();
  });

  it("坏表报错：重复 id、未知 pick、有 pick 缺 then、缺 acp", () => {
    const ok = { id: "x", label: "X", acp: { command: "x", args: [] } };
    expect(() => validateRegistry({ executors: [ok, ok] })).toThrow(/重复/);
    expect(() => validateRegistry({ executors: [{ ...ok, bin: { names: ["x"], discover: [{ path: "~/x", pick: "glob", then: "x" }] } }] })).toThrow(/pick/);
    expect(() => validateRegistry({ executors: [{ ...ok, bin: { names: ["x"], discover: [{ path: "~/x", pick: "newest" }] } }] })).toThrow(/then/);
    expect(() => validateRegistry({ executors: [{ id: "x", label: "X" }] })).toThrow(/acp/);
  });
});
