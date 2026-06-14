#!/usr/bin/env bash
# Stop hook — runs every time Claude finishes a turn.
# Appends a one-line summary of the latest turn to a central, per-branch log in
# the MAIN checkout, so every worktree's history lives in one shared, gitignored
# place that the dashboard (which runs from main) can read.
#
# Wired up in .claude/settings.json. Receives the hook payload as JSON on stdin:
#   { transcript_path, cwd, session_id, hook_event_name, stop_hook_active }

# Guard: the summary itself is produced by a headless `claude` call, whose own
# Stop hook would otherwise fire this script again — a fork bomb. Bail early when
# we're already inside the summarizer.
[ "${WORKTREE_LOG_HOOK:-}" = "1" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0
command -v claude >/dev/null 2>&1 || exit 0

input=$(cat)
transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[ -n "$transcript" ] && [ -f "$transcript" ] || exit 0
[ -n "$cwd" ] || cwd=$PWD

cd "$cwd" 2>/dev/null || exit 0
common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
main=$(dirname "$(cd "$common" && pwd)")
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)
safe=$(printf '%s' "$branch" | tr '/' '-')
logdir="$main/.worktree-logs"
mkdir -p "$logdir"

# Summarize + write asynchronously so we never add latency to the turn.
(
  # Files changed in the latest turn: tool_uses that come after the last *human*
  # prompt (a user event whose content is text, not a tool_result).
  files=$(jq -rs '
    . as $all
    | ([ range(0; ($all | length)) as $i
         | select($all[$i].type == "user"
                  and (($all[$i].message.content | type == "string")
                       or (any($all[$i].message.content[]?; .type == "text")))) | $i ] | last) as $u
    | [ $all[(($u // -1) + 1):][]
        | select(.type == "assistant") | .message.content[]?
        | select(.type == "tool_use" and (.name == "Write" or .name == "Edit" or .name == "NotebookEdit"))
        | .input.file_path ] | unique
  ' "$transcript" 2>/dev/null)
  case "$files" in "" | null) files='[]' ;; esac

  instr='Below is the tail of a Claude Code session transcript in JSONL. In ONE concise sentence (max ~20 words), summarize what the user most recently asked for and what was done in response. Reply with ONLY that sentence — no preamble, no quotes.'
  body=$(tail -c 16000 "$transcript")

  # Run the summarizer from a throwaway dir so its own session transcript lands
  # in a separate ~/.claude/projects entry and never shadows the worktree's real
  # session in the dashboard.
  sdir="${TMPDIR:-/tmp}/worktree-log-summarizer"
  mkdir -p "$sdir"
  summary=$(cd "$sdir" && printf '%s\n\n%s\n' "$instr" "$body" \
    | WORKTREE_LOG_HOOK=1 claude -p --model haiku 2>/dev/null \
    | tr '\n' ' ' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  [ -n "$summary" ] || summary='(summary unavailable)'

  jq -nc --arg b "$branch" --arg s "$summary" --argjson f "$files" \
    '{ts: (now * 1000 | floor), branch: $b, kind: "done", summary: $s, files: $f}' >> "$logdir/$safe.jsonl"
) >/dev/null 2>&1 &

exit 0
