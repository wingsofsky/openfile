/**
 * The runtime's own version, read from its package.json at startup (MCP serverInfo, `openfile --version`).
 * Works from source (src/…) and from the build (dist/cli.mjs): walk up from this module until the
 * package.json named @openfile/runtime.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function runtimeVersion(): string {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg?.name === "@openfile/runtime" && typeof pkg.version === "string") return (cached = pkg.version);
    } catch {
      /* no package.json here: keep walking */
    }
    const up = path.dirname(dir);
    if (up === dir) return (cached = "0.0.0-dev");
    dir = up;
  }
}
