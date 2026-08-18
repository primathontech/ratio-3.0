#!/usr/bin/env bash
# Stop hook: once per session, if this session changed files, nudge a knowledge-doc update so the
# .claude/context/ handbook + mistakes.md don't go stale. Fires exactly ONCE per session (a session-keyed
# sentinel) and only when the working tree actually changed. Never fatal.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

payload="$(cat 2>/dev/null)"
sid="$(printf '%s' "$payload" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("session_id","") or "")
except Exception: pass' 2>/dev/null)"
[ -z "$sid" ] && exit 0   # no session id → cannot de-dup safely, skip

sentinel=".claude/.knowledge-checked-$sid"
[ -f "$sentinel" ] && exit 0   # already nudged this session

changed="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
[ "${changed:-0}" -eq 0 ] && exit 0   # nothing changed → nothing to capture

mkdir -p .claude 2>/dev/null || true
touch "$sentinel" 2>/dev/null || true

python3 - <<'PY' 2>/dev/null || exit 0
import json
print(json.dumps({"decision": "block", "reason": (
  "This session changed files. If it produced material new knowledge — a new convention, an "
  "architecture/render change, a new gotcha, or a roadmap move — update the relevant .claude/context/ "
  "page and/or append a line to .claude/mistakes.md now (see .claude/README.md for the process). "
  "If only routine changes (a bug fix, small refactor, formatting), reply \"no knowledge update needed\" "
  "and stop.")}))
PY
exit 0
