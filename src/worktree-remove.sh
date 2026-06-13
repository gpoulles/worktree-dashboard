#!/usr/bin/env bash
# Usage: worktree-remove.sh <name> <worktrees-path>
set -euo pipefail

NAME="$1"
WORKTREES_PATH="${2:-.claude/worktrees}"

WORKTREE_PATH="$WORKTREES_PATH/$NAME"

if [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "Error: worktree '$NAME' not found at $WORKTREE_PATH" >&2
  exit 1
fi

git worktree remove --force "$WORKTREE_PATH"
echo "Removed worktree '$NAME'"
