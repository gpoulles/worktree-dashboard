#!/usr/bin/env bash
# UserPromptSubmit hook — runs the moment a prompt is submitted, before Claude
# does any work. Records the prompt as the worktree's CURRENT task so the
# dashboard shows "what it's working on" live during the turn. Writes a
# {kind:"start"} entry to the same central, per-branch log the Stop hook later
# appends a {kind:"done"} summary to.
#
# Wired up in .claude/settings.json. Receives the payload as JSON on stdin:
#   { prompt, cwd, session_id, transcript_path, hook_event_name }

# Don't fire inside the Stop hook's headless summarizer call.
[ "${WORKTREE_LOG_HOOK:-}" = "1" ] && exit 0

input=$(cat)
# Critical: UserPromptSubmit stdout is injected into Claude's context. Send all
# of this script's output to the void so we only ever touch the log file.
exec >/dev/null 2>&1

command -v jq >/dev/null 2>&1 || exit 0

prompt=$(printf '%s' "$input" | jq -r '.prompt // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[ -n "$prompt" ] || exit 0
[ -n "$cwd" ] || cwd=$PWD

cd "$cwd" 2>/dev/null || exit 0
common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
main=$(dirname "$(cd "$common" && pwd)")
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)
safe=$(printf '%s' "$branch" | tr '/' '-')
logdir="$main/.worktree-logs"
mkdir -p "$logdir"

# Keep the stored prompt compact — the dashboard only needs a glanceable line.
prompt=$(printf '%s' "$prompt" | tr '\n' ' ' | cut -c1-500)

jq -nc --arg b "$branch" --arg p "$prompt" \
  '{ts: (now * 1000 | floor), branch: $b, kind: "start", prompt: $p}' >> "$logdir/$safe.jsonl"

exit 0
