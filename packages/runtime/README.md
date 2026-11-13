# Openfile runtime

The local runtime behind Openfile: package `@openfile/runtime`, command `openfile`. The desktop app and browser mode run on it, and you can use one part of it on its own: an MCP server that lets any agent read a folder, write its changes as CriticMarkup suggestions you review in Openfile, and compare snapshots.

Chinese directory names such as `会话/` (sessions) are part of the file protocol and appear as-is.

## Connect an agent over MCP

Requires Node ≥ 22.19 and pnpm. The npm package is not published yet, so run it from a clone:

```bash
git clone https://github.com/wingsofsky/openfile.git
cd openfile && pnpm install
```

Register it with your agent. `<folder>` is the folder you want it to work in:

```bash
claude mcp add openfile -- node <openfile-repo>/scripts/openfile-mcp.mjs --root <folder>
```

For Codex it is `codex mcp add openfile -- node …`. Reopen the session so the tools appear. The desktop app's side-panel chat injects the same server into every session, so you need this only for agents you run outside Openfile.

## MCP tools

Thirteen tools in three groups; all load by default, and `--tools` narrows them. See [MCP tool groups](../../docs/guide/mcp-tools.md).

| Group | Tools |
|---|---|
| `library` | `library_info` `list_dir` `read_doc` `search_files` `search_text` `write_doc` |
| `review` | `suggest_edit` `add_comment` `read_annotations` |
| `snapshots` | `list_snapshots` `snapshot_now` `snapshot_changes` `diff_since` |

`suggest_edit` and `add_comment` write signed CriticMarkup marks (`{~~old~>new~~}`, `{>>@claude: …<<}`) into the document instead of overwriting it; you accept or reject each one in Openfile's Review view. Without the desktop app the marks are plain text: keep the text and delete the marks to accept, delete the whole mark to reject. Text inside `【…】` in a document is addressed to the agent, and `read_annotations` returns it along with the marks.

## Snapshots

Openfile keeps snapshots of a folder in a hidden git repository in its app data directory (`~/Library/Application Support/com.wingsofsky.openfile/` on macOS, `%APPDATA%\com.wingsofsky.openfile\` on Windows). The desktop app and the MCP server share it, so an agent's `snapshot_now` shows up in the app's version timeline. Your own `.git` is never touched.

## Conversation archive

The desktop app's History panel can export conversations from the AI CLIs on your machine (Claude Code, Codex, Gemini CLI, Grok, Antigravity, Cursor) as Markdown into the Openfile home folder, `~/.openfile` (set `OPENFILE_HOME` to move it). It runs this command, which you can also run yourself:

```bash
openfile import-sessions --root <archive folder> --project <agent working dir> --list   # preview
openfile import-sessions --root <archive folder> --project <agent working dir>          # import
```

Only conversations from the project you name are imported unless you pass `--all-projects`. Re-running refreshes conversations that continued and leaves hand-edited archives alone. Redaction of common secret patterns is on by default; it will miss things, so review the archive before sharing it. `--help` lists all options.

## Commands

Until the npm package is published, define `openfile` once:

```bash
alias openfile="node <openfile-repo>/packages/runtime/src/cli.ts"
```

| Command | What it does |
|---|---|
| `openfile mcp --root <folder> [--tools <groups>]` | MCP server over stdio |
| `openfile import-sessions --root <folder> …` | import local CLI conversations as Markdown |
| `openfile open <path>` | open a path in the installed desktop app |
| `openfile serve --stdio` | runtime API for the desktop app (it starts this itself) |

`scripts/openfile-mcp.mjs` in the repository is a thin wrapper around `openfile mcp`; the registration above uses it.

## Security

Every file access goes through one path check that rejects absolute paths, `..`, NUL and symlink escapes. It is not a process sandbox: an agent you connect still runs with your user's permissions and its own tools. See [SECURITY.md](../../SECURITY.md).

Apache-2.0.
