# Open Openfile in your agent's browser

A desktop agent with a built-in browser, such as Claude Code in the desktop app, can run Openfile on your folder and work in it while you watch the same view. The agent edits the files or leaves suggestions as review marks; Openfile picks up each change as it lands on disk, and you accept or reject the suggestions in the Review view.

You can hand the whole setup to the agent:

```text
Open the folder <path> in Openfile in your browser pane: follow docs/guide/agent-browser.md in https://github.com/wingsofsky/openfile
```

## Steps

1. Get the code. Needs Node 22.19 or later and pnpm.

   ```bash
   git clone https://github.com/wingsofsky/openfile.git
   cd openfile
   pnpm install
   ```

2. Start browser mode. It serves Openfile at `http://localhost:1420`, with the same runtime the desktop app uses running inside the Vite dev server.

   ```bash
   pnpm dev
   ```

   To open a folder right away, set `OPENFILE_LIBRARY` first: `OPENFILE_LIBRARY=/path/to/folder pnpm dev` on macOS and Linux, `$env:OPENFILE_LIBRARY='D:\notes'; pnpm dev` in PowerShell. Without it, type the folder path on the welcome page and press Open.

   In Claude Code, start it from the browser pane rather than a shell, so it keeps running and opens in the pane. Add an entry to `.claude/launch.json` in the Openfile checkout:

   ```json
   {
     "version": "0.0.1",
     "configurations": [
       { "name": "openfile", "runtimeExecutable": "pnpm", "runtimeArgs": ["dev"], "port": 1420 }
     ]
   }
   ```

3. Work on the folder. The agent can:
   - edit a file directly; the open document refreshes when the file changes;
   - leave suggestions instead, as CriticMarkup signed with its name: `{++@claude: added text++}`, `{--@claude: removed text--}`, `{~~@claude: old~>new~~}`, `{>>@claude: a comment<<}`. You accept or reject them one by one in the Review view;
   - use the interface itself: open files, switch views, read the page.

## Good to know

- Browser mode listens on localhost only, and its file bridge rejects requests from other origins.
- Snapshots for the version timeline go to Openfile's data folder, not into your folder or its `.git`.
- Suggestions you type in browser mode are signed with your operating system user name.
- The side-panel chat works in browser mode too, so the agent in the pane and an agent in Openfile's own panel can work on the same folder. Let one of them write at a time.
