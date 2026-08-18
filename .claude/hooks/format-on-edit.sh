#!/usr/bin/env bash
# PostToolUse hook (Edit|Write|MultiEdit): run Prettier on the edited file. Reads the hook payload as
# JSON on STDIN and pulls tool_input.file_path (Claude Code passes hook input via stdin, not an env var).
# Always exit 0 — formatting is best-effort, never blocks.
set -uo pipefail

f="$(cat 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))
except Exception: pass' 2>/dev/null)"
[ -z "$f" ] && exit 0

case "$f" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.md|*.css|*.scss)
    [ -f "$f" ] && npx --yes --no-install prettier --write "$f" >/dev/null 2>&1 || true ;;
esac
exit 0
