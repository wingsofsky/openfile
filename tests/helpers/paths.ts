/**
 * Temp fixtures in the canonical form product code compares against (packages/runtime/src/lib/scoped.mjs canonicalRoot).
 * On Windows that is realpathSync.native, which also expands 8.3 short names: GitHub's Windows runners have
 * TEMP=C:\Users\RUNNER~1\..., and the JS realpathSync keeps such an alias, so roots built with it stop matching
 * the paths the product hands back. Elsewhere realpathSync (macOS: /var → /private/var).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Canonical form of an existing path. */
export function canonical(p: string): string {
  return process.platform === "win32" ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

/** Fresh directory under os.tmpdir(), returned in canonical form. */
export function tempDir(prefix: string): string {
  return canonical(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
