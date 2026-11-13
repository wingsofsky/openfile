// Dependency direction: desktop UI -> protocol, runtime -> protocol, protocol -> nothing.
// The protocol package may only import files from its own src directory: no packages, no node:, no IO.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PROTOCOL_SRC = path.resolve("packages/protocol/src");
const SPEC = /(?:^|[^\w$.])(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function specifiers(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(SPEC)].map((m) => m[1]);
}

describe("package boundaries", () => {
  const sources = fs
    .readdirSync(PROTOCOL_SRC)
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .map((n) => path.join(PROTOCOL_SRC, n));

  it("protocol has kernels to check", () => {
    expect(sources.length).toBeGreaterThanOrEqual(3);
  });

  it("protocol sources only import siblings in their own directory, with explicit extensions", () => {
    const bad: string[] = [];
    for (const file of sources) {
      for (const spec of specifiers(file)) {
        const sibling = /^\.\/[a-z0-9-]+\.(ts|json)$/.test(spec) && fs.existsSync(path.join(PROTOCOL_SRC, spec));
        if (!sibling) bad.push(`${path.basename(file)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("protocol package declares no dependencies", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("packages/protocol/package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });
});
