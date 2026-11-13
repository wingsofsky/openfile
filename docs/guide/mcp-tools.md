# MCP tool groups

The Openfile MCP server has 13 tools in three groups. All of them load by default. Every tool definition sits in the agent's context for the whole session, so if your agent needs only some of them, register the server with `--tools`.

```bash
# default: all three groups
claude mcp add openfile -- node <openfile-repo>/scripts/openfile-mcp.mjs --root <folder>

# only suggestions and comments
claude mcp add openfile -- node <openfile-repo>/scripts/openfile-mcp.mjs --root <folder> --tools review

# several groups, comma-separated; `all` is the same as the default
claude mcp add openfile -- node <openfile-repo>/scripts/openfile-mcp.mjs --root <folder> --tools review,snapshots
```

To change the groups of an existing registration, remove it (`claude mcp remove openfile`) and add it again. The server instructions shrink with the groups: rules for tools you did not load are left out, and the agent is told which groups exist so it can ask you to add one.

## Groups

| Group | Tools | What it is for | Leave it out when |
|---|---|---|---|
| `review` | `suggest_edit` `add_comment` `read_annotations` | Write changes to a document as signed CriticMarkup suggestions instead of overwriting it; read the marks and the `【…】` notes addressed to the agent | Never, if you review agent edits in Openfile |
| `snapshots` | `list_snapshots` `snapshot_now` `snapshot_changes` `diff_since` | Snapshot the folder before a risky change and diff against it afterwards | The desktop app already snapshots on its own and you do not need the agent to |
| `library` | `library_info` `list_dir` `read_doc` `search_files` `search_text` `write_doc` | Read, search and write files through Openfile's path checks | Your agent has its own file tools (Claude Code and Codex do); keep it for full-text search over `会话/` (the conversation archive) |

## What is not affected

- **The desktop app's side-panel chat** starts its own MCP server with `--tools all`, whatever you registered elsewhere.
- **Snapshots taken by the app** appear in `list_snapshots`, and snapshots taken by an agent appear in the app's version timeline: both use the same hidden repository.
