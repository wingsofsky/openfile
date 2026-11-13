# Security

Openfile is local-first. Its file interfaces validate paths against the opened folder, but the application and the agents it launches are not confined to that folder at the process level. Read the permissions below by execution path.

## What can touch your files

| Path | Who | What it can do |
|---|---|---|
| Desktop app / browser mode | you | folder file operations go through the runtime's path check, `scoped.mjs` (rejects `..`, absolute paths, NUL, symlink escapes; `resolve_scoped` in Rust is the reference implementation); app settings and shadow snapshots use separate local storage. Exporting conversations reads the local records of the AI CLIs on your machine. |
| MCP server (stdio) | agents you run yourself (Claude Code, Codex, …), including the side-panel chat | read, search and write files, add CriticMarkup suggestions, take and compare snapshots — the same trust as running that agent in the folder |
| Side-panel chat (ACP) | agents you start from the panel | they run with their own tools, permissions and sandbox configuration, in the opened folder. A preset's command (such as `grok`) is resolved from an environment override, `PATH` and known install locations, and a program with the same name inside the opened folder is never started instead. The custom-command preset starts whatever program and arguments you type. |

Starting an agent in a folder means trusting that folder. Presets that start their adapter through `npx` run npm in the opened folder, so npm reads that folder's project configuration (`.npmrc`) and its local packages, and the agent itself reads its own project settings there. Start agents only in folders you trust.

CriticMarkup suggestions can be accepted or rejected individually. This does **not** enforce approval for every write: MCP `write_doc`, an agent's own file tools and the commands it runs can change files directly. Grant agents only the permissions you intend them to have.

## Network exposure

- Openfile has no telemetry. Reading is local. Starting an agent goes online through that agent; the first start of an ACP adapter may download it through `npx`. Exported conversations and document contents you send to an agent are subject to that service's handling of data.
- Browser mode (`pnpm dev`) listens on localhost only. Its file bridge checks Host and Origin, and writes require `application/json` and an `x-openfile-request` header.
- HTML previews put their resource CSP before all report bytes. The parent page restricts frame destinations, including navigation requested by report scripts or refresh tags. Packaged desktop previews also inherit the host CSP; report scripts do not run there. An external-link message from a report only displays its URL: opening it in the system browser requires a separate click on the host's confirmation button. This deliberate extra step prevents report scripts from using the link handler to open remote URLs automatically.

## Sharing and sync

- Before sharing a folder, inspect document bodies, review drafts, local paths, hostnames and screenshots. Conversation export redacts common secret patterns but cannot remove every credential or personal detail; inspect its suspicious-entropy report and the resulting archive.
- Removing a file or secret from the current folder does not erase older shadow snapshots, exported archives, backups or Git history. Check historical copies separately before publishing or syncing. Revoke exposed credentials at their issuer; deleting the visible string does not revoke it.
- Side-panel conversations are archived automatically (visible user and assistant text only) to `会话/内嵌/` (sessions/embedded) when the opened folder already contains `.openfile/`; otherwise to `sessions/` in Openfile's app data directory, never into the opened folder. No archive is redacted automatically. Thought streams, raw tool payloads and diagnostic output are left out.
- Conversation export defaults to the project you are in; only an explicit file selection or `--all-projects` broadens that scope.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository, or email the maintainer (address in the GitHub profile). Include the version, your platform and a reproduction. You will get a reply within 7 days.

## Known limitations

- The desktop app does not provide a process sandbox for agents it launches. A CLI's selected sandbox may add restrictions; changing its working directory alone does not.
- Unsigned builds may trigger macOS Gatekeeper or Windows SmartScreen warnings or blocks.
