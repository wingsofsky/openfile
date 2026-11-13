/**
 * Build-time bundling for @openfile/runtime. Development runs the TS sources directly;
 * releases ship these bundles instead:
 *
 *   node packages/runtime/scripts/build.mjs                 both targets
 *   node packages/runtime/scripts/build.mjs --cli           dist/cli.mjs (the `openfile` bin, npm package)
 *   node packages/runtime/scripts/build.mjs --desktop-cli   src-tauri/resources/openfile-cli/ (desktop resource: the
 *                                                           runtime sidecar and the MCP server for chat sessions)
 *
 * @openfile/protocol is bundled in. For the npm package the runtime dependencies stay external
 * and come from the package's own dependencies; the desktop CLI bundles them too, except chardetng-wasm,
 * whose .wasm is resolved at run time and is copied next to the bundle as node_modules/chardetng-wasm.
 * Build logs go to stderr.
 */
import { build } from "esbuild";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const pkg = JSON.parse(fs.readFileSync(here("../package.json"), "utf8"));

export const cliBundle = here("../dist/cli.mjs");
export const desktopCliDir = here("../../../src-tauri/resources/openfile-cli");

/**
 * Write only when the bytes differ. tauri-build marks every bundled resource rerun-if-changed, and
 * src-tauri/build.rs regenerates these resources on each build: rewriting identical files bumps their
 * mtime and makes `tauri dev` rebuild forever.
 */
function writeIfChanged(file, bytes) {
  try {
    if (Buffer.compare(fs.readFileSync(file), Buffer.from(bytes)) === 0) return;
  } catch {
    /* missing: write it */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

/** esbuild into memory, then writeIfChanged */
async function bundleTo(outfile, options) {
  const result = await build({ ...options, outfile, write: false });
  for (const f of result.outputFiles) writeIfChanged(f.path, f.contents);
}

// Bundled CJS dependencies may require Node built-ins dynamically.
const requireShim = "import { createRequire as __ofRequire } from 'node:module'; const require = __ofRequire(import.meta.url);";

export async function buildCli() {
  await build({
    entryPoints: [here("../src/cli.ts")],
    outfile: cliBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
    external: Object.keys(pkg.dependencies ?? {}),
    banner: { js: `#!/usr/bin/env node\n${requireShim}` },
  });
}

/** The full `openfile` command for the desktop app: one bundle plus chardetng-wasm (Tauri resource). */
export async function buildDesktopCli() {
  await bundleTo(path.join(desktopCliDir, "cli.mjs"), {
    entryPoints: [here("../src/cli.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
    banner: { js: requireShim },
  });
  // runtimeVersion() walks up to the package.json named @openfile/runtime
  const manifest = { name: pkg.name, version: pkg.version, private: true, type: "module" };
  writeIfChanged(path.join(desktopCliDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const from = path.dirname(createRequire(import.meta.url).resolve("chardetng-wasm/package.json"));
  const to = path.join(desktopCliDir, "node_modules", "chardetng-wasm");
  for (const f of ["package.json", "LICENSE"]) writeIfChanged(path.join(to, f), fs.readFileSync(path.join(from, f)));
  for (const f of ["chardetng_wasm.js", "chardetng_wasm_bg.js", "chardetng_wasm_bg.wasm"]) {
    writeIfChanged(path.join(to, "dist", f), fs.readFileSync(path.join(from, "dist", f)));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const all = !["--cli", "--desktop-cli"].some((a) => args.includes(a));
  if (all || args.includes("--cli")) await buildCli();
  if (all || args.includes("--desktop-cli")) await buildDesktopCli();
}
