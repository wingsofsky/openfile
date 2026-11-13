// MCP tool groups (--tools): every registered tool belongs to exactly one group, otherwise it would silently
// disappear from the default (all groups) server. Instructions only mention tools of enabled groups.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_TOOL_GROUPS, TOOL_GROUPS, instructions } from "../packages/runtime/src/mcp/tool-policy.ts";

const TOOLS_DIR = path.resolve("packages/runtime/src/mcp/tools");

function registeredTools(): string[] {
  const names: string[] = [];
  for (const f of fs.readdirSync(TOOLS_DIR).filter((n) => n.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(TOOLS_DIR, f), "utf8");
    for (const m of src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)) names.push(m[1]);
  }
  return names.sort();
}

describe("MCP tool groups", () => {
  const grouped = Object.values(TOOL_GROUPS).flat() as string[];

  it("cover every registered tool exactly once", () => {
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(registeredTools());
  });

  it("instructions keep only the rules of enabled groups", () => {
    const lean = instructions(new Set(["snapshots"]));
    expect(lean).toContain("snapshot_now");
    expect(lean).not.toContain("suggest_edit");
    expect(lean).toContain("--tools");
    const full = instructions(new Set(ALL_TOOL_GROUPS));
    expect(full).toContain("suggest_edit");
    expect(full).not.toContain("--tools");
  });
});
