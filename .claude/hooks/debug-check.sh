#!/usr/bin/env bash
# Stop hook: warn about debug statements added this session — both in ADDED lines of tracked files
# (scoped vs HEAD so a pre-existing console.log elsewhere doesn't fire every turn) AND in brand-new
# untracked files (the common case for code just written). Non-blocking; always exit 0.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

{
  # Added lines in tracked files (staged + unstaged) vs HEAD.
  git diff -U0 HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null \
    | grep -E '^\+' | grep -vE '^\+\+\+' | grep -E '(console\.log|debugger)'
  # New untracked files (portable — no `xargs -r`, which BSD/macOS lacks).
  git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null \
    | while IFS= read -r f; do
        [ -f "$f" ] && grep -Hn -E '(console\.log|debugger)' "$f" 2>/dev/null
      done
} | head -5 | sed 's/^/[hook] debug statement added: /' >&2 || true
exit 0
