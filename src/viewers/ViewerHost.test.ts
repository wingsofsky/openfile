// @vitest-environment node
import { describe, expect, it } from "vitest";
import { build } from "esbuild";

describe("试验场发行边界", () => {
  it("生产构建完全去掉试验场依赖，开发构建保留入口", async () => {
    for (const dev of [false, true]) {
      const result = await build({
        entryPoints: ["src/viewers/ViewerHost.tsx"], bundle: true, write: false,
        outfile: "viewer-test.js", format: "esm", platform: "browser", packages: "external",
        metafile: true, define: { "import.meta.env.DEV": String(dev) }, logLevel: "silent",
      });
      const inputs = Object.values(result.metafile!.outputs).flatMap((output) => Object.keys(output.inputs));
      expect(inputs.some((input) => input.endsWith("/spike/SpikePage.tsx"))).toBe(dev);
      if (!dev) expect(result.outputFiles[0].text).not.toContain("prosemirror-suggest-changes");
    }
  });
});
