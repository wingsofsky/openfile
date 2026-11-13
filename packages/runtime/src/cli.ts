/**
 * `openfile` command: one entry, subcommands dispatch to the runtime's modules.
 *
 *   openfile mcp --root <library> [--tools …]       MCP server over stdio (read, review, snapshots)
 *   openfile import-sessions --root <archive> …     import local CLI transcripts as Markdown (the History panel's export)
 *   openfile open <file-or-folder>                  hand a path to the installed desktop app
 *   openfile serve --stdio                          runtime API for the desktop app (sidecar, NDJSON JSON-RPC)
 *
 * Each module reads process.argv itself, so the subcommand is removed before it loads.
 * scripts/openfile-mcp.mjs forwards here; stdout stays owned by the module (JSON-RPC, NDJSON).
 */
import { runtimeVersion } from "./version.ts";

const COMMANDS: Record<string, { load: () => Promise<unknown>; about: string }> = {
  mcp: { load: () => import("./mcp/server.ts"), about: "MCP server over stdio: read, review and snapshot tools" },
  "import-sessions": { load: () => import("./sessions/session-import.mjs"), about: "import local CLI transcripts into the library" },
  open: { load: () => import("./open-cli.ts"), about: "open a file or folder in the Openfile desktop app" },
  serve: { load: () => import("./api/stdio.ts"), about: "runtime API over stdio (desktop sidecar; --stdio)" },
};

function usage(): string {
  const rows = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(18)}${c.about}`);
  return [`openfile ${runtimeVersion()}`, "", "usage: openfile <command> [options]", "", ...rows].join("\n");
}

const sub = process.argv[2];
if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
  console.log(usage());
} else if (sub === "--version" || sub === "-v") {
  console.log(runtimeVersion());
} else if (!Object.hasOwn(COMMANDS, sub)) {
  console.error(`openfile: unknown command "${sub}"\n\n${usage()}`);
  process.exitCode = 2;
} else {
  process.argv.splice(2, 1);
  await COMMANDS[sub].load();
}
