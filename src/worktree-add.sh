#!/usr/bin/env bash
# Usage: worktree-add.sh <name> <branch> <worktrees-path>
set -euo pipefail

NAME="$1"
BRANCH="$2"
WORKTREES_PATH="${3:-.claude/worktrees}"

WORKTREE_PATH="$WORKTREES_PATH/$NAME"

if [[ -d "$WORKTREE_PATH" ]]; then
  echo "Error: worktree '$NAME' already exists at $WORKTREE_PATH" >&2
  exit 1
fi

mkdir -p "$WORKTREES_PATH"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add "$WORKTREE_PATH" "$BRANCH"
else
  git worktree add -b "$BRANCH" "$WORKTREE_PATH"
fi

echo "Created worktree '$NAME' at $WORKTREE_PATH (branch: $BRANCH)"
