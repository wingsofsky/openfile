# Contributing

Thanks for looking. Openfile is a small, opinionated codebase; the three rules below are non-negotiable, everything else is open for discussion in an issue first.

## The three invariants

1. **Path safety** — library file operations go through `src-tauri/src/scope.rs::resolve_scoped` (JS side: `packages/runtime/src/lib/scoped.mjs`). New commands ship with attack tests (`..`, absolute paths, symlink escape, NUL, and no side effects when creating through an escaping symlink). App settings, shadow storage and explicit session import have separate host paths; document and test those boundaries. Launched CLIs are not confined by this resolver.
2. **Aesthetic contract** — UI follows [docs/design/literary-style.md](docs/design/literary-style.md). No new color / font / motion tokens without changing the contract first.
3. **Format sovereignty** — review state is plain text (CriticMarkup marks, and Markdown drafts next to Word, PDF and HTML originals). No private binary state.

## Before you start

For anything larger than a fix, open an issue first. If your change is architecture-level (a new file format, a new dependency, a change to how the MCP server or the review marks work, or a move away from Tauri, ProseMirror or CodeMirror 6), describe it in the issue in three parts: **context** (what problem, what constraints), **proposal** (what you want to do), **consequences** (what it costs, what it rules out, what has to change with it).

## Dev loop

```bash
pnpm install
pnpm dev            # browser mode (no Rust needed)
pnpm tauri dev      # desktop app
pnpm test && pnpm typecheck
pnpm e2e            # fs bridge + path attacks
pnpm e2e:mcp        # MCP server: path attacks / review / snapshots / tool groups
pnpm e2e:acp        # ACP transport and sessions
pnpm e2e:pack       # runtime package installed outside the repo (openfile mcp / open)
cd src-tauri && cargo test
```

Windows and macOS are both release platforms, and CI must be green on both (tests, typecheck, build and the four E2E suites on Node 22 and 24; `cargo test` on both OSes). Run `pnpm test && pnpm typecheck` for frontend changes, the corresponding E2E suite for bridge / MCP / ACP changes, and `cargo test` for Rust changes. On Windows without Developer Mode, file symlinks cannot be created, so the few assertions that need one are skipped locally and say so ("file symlink needs Developer Mode on Windows"); directory links fall back to junctions and always run. CI runners are admin, so every assertion runs there. Explain the resulting behavior and relevant validation in the PR.

## Language

Code comments: English or mixed. Commit messages use Conventional Commits prefixes (`feat:`, `fix(agent):`, `docs:`, `chore(release):` …); the description may be in English or Chinese. The UI supports Chinese and English: write Chinese literal keys through `t()` and add their English translations to `src/i18n/en.ts`. Use placeholders for dynamic values and run `node scripts/i18n-extract.mjs --missing` to check coverage. Directory names, paths and review markers stay unchanged; translate only their display labels. Issues and PRs in either language are fine.

## Reporting bugs

Include OS, Openfile version or Git commit, the build time shown in the status bar, and whether you were in browser mode or the desktop app. Redact private paths, hostnames, credentials and document contents from logs or screenshots. For anything security-related see [SECURITY.md](SECURITY.md).
