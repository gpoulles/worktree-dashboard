# @gpoulles/worktree-dashboard

A local dashboard for monitoring and managing git worktrees with Claude Code agents.

![Dashboard screenshot](screenshot.png)

## Install

```bash
npm install -g @gpoulles/worktree-dashboard
```

Or run without installing:

```bash
npx @gpoulles/worktree-dashboard
```

## Usage

```bash
worktree-dashboard [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port <number>` | `3333` | Port to listen on |
| `--logo <path>` | — | Path to a local image file, embedded as base64 |
| `--title <string>` | `"Worktree Dashboard"` | Title shown in the header |
| `--worktrees <path>` | `.claude/worktrees` | Path to the worktrees folder |
| `--config <path>` | `.worktree-dashboard.json` | Path to a config file |

## Config file

Create `.worktree-dashboard.json` in your project root. CLI flags override these values.

```json
{
  "port": 3333,
  "logo": "./logo.png",
  "title": "My Dashboard",
  "worktrees": ".claude/worktrees"
}
```

## Running dev servers per worktree

Add a `run` block to start a project script (e.g. `ng serve`) from each worktree, with a different port per worktree so they can run side by side.

```json
{
  "run": {
    "scripts": ["start"],
    "command": "npm run {script} -- --port {port}",
    "basePort": 4200
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `scripts` | `["start"]` | Allowlist of `package.json` scripts that may be started. Only scripts that exist in a worktree's `package.json` are shown. |
| `command` | `npm run {script} -- --port {port}` | Command template. `{script}` and `{port}` are substituted before running. |
| `basePort` | `4200` | Port for the first worktree; each subsequent worktree gets `basePort + index`, skipping ports already in use. |

When `run` is configured, each worktree card gets a **Start** control. Starting a script launches it in the worktree directory with the assigned port (also exported as the `PORT` env var) and shows a clickable `localhost:<port>` link. **Stop** terminates the process group. Processes are also stopped when the dashboard shuts down.

For an Angular worktree, the default command runs `ng serve --port 4201`, `4202`, … one per worktree. Frameworks that read the `PORT` env var (Next.js, Create React App) work with a simpler `"command": "npm run {script}"`.

## How it works

The dashboard reads from `~/.claude/projects/` — the JSONL session files written by Claude Code as it runs agents in each worktree. It parses these files to determine the current status of each agent (working, thinking, waiting, done, idle) and surfaces the last tool used, last file touched, and last message.

Each worktree card links to VS Code so you can jump straight to the relevant file.

## Requirements

- Node.js 18+
- git
- VS Code with `code` on PATH

## WSL

On Windows Subsystem for Linux the browser opens automatically via `explorer.exe`.

## License

MIT
