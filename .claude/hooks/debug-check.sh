#!/usr/bin/env bash
# Stop hook: warn about debug statements ADDED this session — scoped to added lines vs HEAD (so a
# pre-existing console.log elsewhere in the tree doesn't fire every turn). Non-blocking; always exit 0.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

git diff -U0 HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null \
  | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -E '(console\.log|debugger)' \
  | head -5 \
  | sed 's/^/[hook] debug statement added: /' >&2 || true
exit 0
