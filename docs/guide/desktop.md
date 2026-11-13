# Openfile Desktop guide

The desktop app opens a folder as a library: read whatever your agents produced, see exactly what each turn changed, review suggestions one by one and roll back block by block. Connecting other agents over MCP and the conversation archive are covered in the [runtime guide](../../packages/runtime/README.md).

Overview: [README](../../README.md).

## Install

Download from [Releases](https://github.com/wingsofsky/openfile/releases): an NSIS installer for Windows, a dmg for macOS (Apple Silicon and Intel). The installers are unsigned, so allow them on first launch: on Windows click "More info → Run anyway" in SmartScreen; on macOS 15 and later go to System Settings → Privacy & Security and click "Open Anyway". The Windows package has not been release-validated yet.

The installer bundles Node and git for the app's own use. To connect an external agent such as Claude Code over MCP, you still clone the repository; see the runtime guide.

Or run it from source in a browser (Node ≥ 22.19 and pnpm; no Rust needed):

```bash
pnpm install
pnpm dev        # open http://localhost:1420 and enter the folder's absolute path
```

Building the desktop app yourself needs Rust (plus Xcode command line tools on macOS): `pnpm tauri dev` or `pnpm tauri build`.

## Open a library

Click **Choose library folder** or drag a folder into the window. Openfile does not move files or build a database: the folder is the library. When you open a single file from your system, Openfile walks up from it to the nearest `.git` or `.openfile/` and opens that workspace. One window holds one library; the library menu has **Open in new window**.

Review writes back into files, so try it on a copy first.

## Reading

- **Markdown**: typeset for long-form reading, with an outline and progressive rendering for large files (a 500 KB document stays smooth).
- **HTML reports**: rendered in a sandbox; scripts embedded in the report do not run. Clicking an external link shows the full address and asks before handing it to your browser. To edit or comment on a report, see HTML review drafts under Review below.
- **docx**: high-fidelity, including tracked changes and comments. **pdf**: rendered with pdf.js, read-only. Word editing and PDF notes are under Review below.
- **Images and text**: encodings such as GBK are detected automatically; UTF-8 text is editable.
- The file tree hides `.git` and `node_modules` but shows agent contract files such as `.claude` and `CLAUDE.md`. Quick open: `⌘P` / `Ctrl+P`.
- Open views reload when an agent changes the file on disk. Light and dark themes; English and Chinese UI.

## See what AI changed

**Shadow snapshots**: Openfile snapshots your library into a separate hidden git repository in its app data directory and never touches your own `.git`. A snapshot is taken 45 seconds after files change. The timeline (`⌘Y` / `Ctrl+Y`) shows word-level diffs and restores one file or the whole library.

**Chat edits**: every turn of an in-app chat is bracketed by snapshots. The chat panel lists the files the turn changed, and open documents mark the changes: Markdown and text block by block (keep or roll back each), docx by paragraph (roll back the whole file), or roll back the whole turn. Changes are computed from snapshots, so they show up no matter which CLI wrote the file.

**Review**: suggestions from agents (through the MCP tool `suggest_edit`, or written by hand) are CriticMarkup marks: `{++insert++}`, `{--delete--}`, `{~~old~>new~~}`, `{>>comment<<}`, each signed by its author. Accept or reject them one by one, or all at once with **Apply changes** / **Reject changes** in the document toolbar; switch to **Edit** to see the plain-text marks. You can select a sentence to add your own comment. **Copy prompt** in the toolbar copies a ready-made request with the file's exact path ("look at my comments in this file, answer them and apply the changes") to paste into your agent.

You can also edit directly in the **Review** view: typing, replacing a selection and deleting are recorded as your own tracked changes instead of changing the text, Word style. Line breaks and formatting changes still go through **Edit**, which edits the Markdown directly with no tracked changes, at the same type size and background as Review.

**Word round trip**: open a `.docx` and choose **Review & edit**. Openfile writes a review draft next to it (`name.docx.review.md`) and opens it in the Review view. When you are done, **Export Word revision** writes `name.reviewed.docx` with native Word tracked changes and comments, each under its author; the original and earlier exports are never overwritten. Export refuses if the original changed after the draft was made, or if text was changed outside the review marks.

**Literature notes from PDFs**: open a PDF and choose **Markdown notes**. Openfile converts it on your machine with [Docling](https://github.com/docling-project/docling) (install it once with `uv tool install docling` or `pipx install docling`; the first conversion downloads its models) and writes `name.pdf.md` next to the PDF. The note opens in the Review view, where you can only highlight and comment, so the paper's text stays as converted. Every page starts with a `p. N` link that jumps back to that page of the PDF. The PDF itself is never modified. Conversion quality depends on the PDF: two-column layouts, tables and references usually come through; formulas arrive as plain text, and scanned PDFs need OCR.

**HTML review drafts**: open an `.html` file and choose **Review & edit**. Openfile converts it to Markdown on your machine (no Python, nothing leaves your computer) and writes `name.html.review.md` next to it, opened in the Review view. Edit and comment as in any Markdown file; the agent reads the draft and applies your changes to the HTML source, since Openfile does not write the HTML back. Scripts, styles, SVG charts and forms are dropped; embedded `data:` images keep only their alt text; relative links and images keep working because the draft sits next to the HTML. An existing draft is reused, never overwritten: if the HTML changed after the draft was made, Openfile says so, and you move the old draft to the Trash to convert the new version.

Locally trusted agents can still write files directly. Review marks are not a mandatory approval gate; snapshots help you look back but do not replace permission limits.

## In-app chat

**Sessions** in the status bar (`⌘J` / `Ctrl+J`) runs Claude Code, Codex and other agents in a side panel, with tool calls, permission requests and plans visible step by step. The session is connected to this library's Openfile MCP automatically. The first start downloads an adapter through npx and can take a minute or two; sign in to that CLI in a terminal first. One session at a time: **End** it before switching agents.

The chat runs in the library folder, and every message carries the path of the file you have open, so the agent can read both without you adding anything; nothing extra is shown in the panel. User and assistant text is saved as Markdown: in `会话/内嵌/` (sessions/embedded) when the folder is a library, or in the app data directory when the folder has no `.openfile/` yet. **History** searches in-app chats and exported CLI chats together; open the original or start a new chat that quotes it. The History panel can also **export chats** from every CLI on this machine (Claude Code, Codex, Gemini CLI, Grok, Antigravity, Cursor) into one conversation archive in the Openfile home folder (`~/.openfile`, or `OPENFILE_HOME`): **Export this folder's chats** takes only the conversations that ran in the open folder, **Export all chats** takes every project. Each chat becomes Markdown under `会话/导入/<project>/` in the archive, with an index and likely secrets redacted. Nothing is written into the open folder; it is a plain parser, so no model is called and nothing goes online. **Open Openfile home** opens the archive as a library (in a new window in the desktop app), where the file tree, search and History work as usual. More options are in the [runtime guide](../../packages/runtime/README.md#conversation-archive).

## Known issues

- The Windows desktop package has not been release-validated.

## Privacy

Browsing a library happens locally; there is no telemetry. Starting agents and downloading their adapters go online. Chat archives and snapshots can contain personal information, and archives inside the library sync with it; check before sharing. See [SECURITY.md](../../SECURITY.md).
