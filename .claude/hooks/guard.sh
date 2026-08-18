#!/usr/bin/env bash
# PreToolUse guard (matcher: Bash). Deterministically blocks always-wrong / dangerous commands so the
# non-negotiables in .claude/rules/ are enforced, not just documented.
# Exit 2 = block the command (Claude sees the reason on stderr). Exit 0 = allow.
# Claude Code passes the hook payload as JSON on STDIN (there is no CLAUDE_TOOL_INPUT env var).
# Written for bash 3.2 (macOS default). Escape hatch: export CLAUDE_SKIP_GUARD=1 BEFORE launching claude
# (hooks inherit claude's environment; a prefix on the blocked command itself does not reach the hook).
set -uo pipefail

[ "${CLAUDE_SKIP_GUARD:-0}" = "1" ] && exit 0

cmd="$(cat 2>/dev/null | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command", d.get("command","")))
except Exception: pass' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

block() { printf '%s\n' "$1" >&2; exit 2; }

# 1. Never stage the whole working tree — a teammate's uncommitted WIP could be swept into your commit.
if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+add[[:space:]]+(-A|--all|\.)([[:space:]]|$)'; then
  block "[guard] 'git add -A / . / --all' is forbidden — stage specific paths (.claude/rules/git-workflow.md)."
fi

# 2. Never force-push (rewrites shared history). --force-with-lease is the sanctioned escape hatch.
if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+push' \
   && printf '%s' "$cmd" | grep -qE '(--force([[:space:]]|=|$)|[[:space:]]-f([[:space:]]|$))' \
   && ! printf '%s' "$cmd" | grep -q 'force-with-lease'; then
  block "[guard] force-push is forbidden — use --force-with-lease if you truly must (.claude/rules/git-workflow.md)."
fi

# 3. Deploys are outward/irreversible — a human runs them explicitly (staging cutover, wrangler, ECS).
if printf '%s' "$cmd" | grep -qE '(wrangler[[:space:]]+deploy|(npm|bun|pnpm|yarn)[[:space:]]+run[[:space:]]+deploy|aws[[:space:]]+s3[[:space:]]+sync|aws[[:space:]]+ecs[[:space:]]+update-service|docker[[:space:]]+push)'; then
  block "[guard] deploy commands are blocked — deploys are an explicit human/ops step. To override, export CLAUDE_SKIP_GUARD=1 before launching claude (.claude/rules/git-workflow.md)."
fi

# 4. Catastrophic deletes: rm -rf against filesystem root, home, or unbounded globs.
if printf '%s' "$cmd" | grep -qE 'rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr)[[:space:]]+(/|~|\$HOME|\*|\.\.)([[:space:]]|/|$)'; then
  block "[guard] refusing a broad 'rm -rf' against / ~ \$HOME * or .. — delete specific paths."
fi

# 5. Hardcoded secrets in the command text (prevents echoing/committing a live credential).
if printf '%s' "$cmd" | grep -qE '(AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})'; then
  block "[guard] a hardcoded secret pattern is present in this command — do not echo/commit credentials (.claude/rules/security.md)."
fi

exit 0
