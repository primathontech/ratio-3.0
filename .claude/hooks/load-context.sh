#!/usr/bin/env bash
# SessionStart hook: open every session oriented — current branch, recent commits, and working-tree
# status get injected as additionalContext. Cheap; keeps Claude from starting cold. Always exit 0.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Housekeeping: the knowledge-nudge Stop hook drops a per-session sentinel; clean stale ones so they
# don't accumulate (they're git-ignored, one per session).
find .claude -maxdepth 1 -name '.knowledge-checked-*' -mtime +1 -delete 2>/dev/null || true

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
commits="$(git log --oneline -5 2>/dev/null)"
status="$(git status --short 2>/dev/null | head -20)"

ctx="Repo orientation (auto, from SessionStart hook):
- Branch: ${branch:-unknown}
- Recent commits:
${commits:-  (none)}
- Working tree:
${status:-  clean}

Before non-trivial work: read CLAUDE.md + the relevant .claude/context/ page + .claude/rules/. Branch
off main; never git add -A; never commit/push without explicit approval."

# Emit as SessionStart additionalContext (python3 is already a hook dependency here; avoids needing jq).
python3 - "$ctx" <<'PY' 2>/dev/null || true
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": sys.argv[1]}}))
PY
exit 0
