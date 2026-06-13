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
