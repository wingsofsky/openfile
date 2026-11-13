// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readTextScoped } from "../packages/runtime/src/lib/scoped.mjs";
import { tempDir } from "./helpers/paths.ts";

const fixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/text-encodings.json", import.meta.url), "utf8"));
describe("Rust/JS legacy encoding contract", () => {
  for (const fixture of fixtures) it(fixture.name, async () => {
    const root = tempDir("openfile-encoding-");
    try {
      fs.writeFileSync(path.join(root, "sample.txt"), Buffer.from(fixture.hex, "hex"));
      const result = await readTextScoped(root, "sample.txt");
      expect(result.encoding).toBe(fixture.encoding);
      expect(result.content).toBe(fixture.content);
      expect(result.truncated).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
