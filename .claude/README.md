# `.claude/` — Project Config & How to Maintain It

This folder is the Claude Code configuration for the Ratio 3.0 repo. It's committed so every developer
(and Claude) inherits the same context, rules, tooling, and guardrails. This file explains **what's
here** and **the process for adding or updating it** — keep it current as the project evolves.

## Layout

| Path                     | What it is                                                                                          | Loaded                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `../CLAUDE.md`           | The anchor: what-it-is, commands, architecture, top gotchas, pointers.                              | Every session                         |
| `rules/*.md`             | Non-negotiable behavior (git, testing, security, coding style).                                     | Every session                         |
| `context/*.md`           | The deep handbook (architecture, theme system, gotchas, roadmap, integrations).                     | On demand (read when relevant)        |
| `agents/*.md`            | Subagents: code-reviewer, adversarial-reviewer, security-auditor, principal-architect, test-writer. | When that agent is invoked            |
| `skills/<name>/SKILL.md` | Workflows: run-tests, theme-change, plan-feature, triage-error, ship-pr.                            | Auto-activated by their `description` |
| `commands/*.md`          | Slash commands: `/review`, `/audit`.                                                                | When you type `/<name>`               |
| `hooks/*.sh`             | Hook scripts: guard, load-context, format-on-edit, debug-check, knowledge-nudge.                    | Wired via `settings.json`             |
| `settings.json`          | **Shared** permissions (allow/deny) + hooks (SessionStart/PreToolUse/PostToolUse/Stop).             | Every session                         |
| `settings.local.json`    | **Personal** overrides (UI, effort). **Git-ignored** — do not commit.                               | Every session (per dev)               |
| `mistakes.md`            | Running lessons-learned log.                                                                        | On demand                             |

## Which agent / command when?

- **Reviewing a diff** → `/review` — runs `code-reviewer` (structured checklist + Security/Coverage
  tables) and `adversarial-reviewer` (attacker lens) in parallel with independent context, then merges,
  dedupes, and applies a >80% confidence gate. Loop until clean before merge.
- **Auditing the whole app / a security scan** → `/audit` (comprehensive: security + reliability +
  concurrency + accessibility + UI, tracing real flows end-to-end, with a release recommendation).
  `/audit security` or the `security-auditor` agent directly for a security-only deep pass. Read-only —
  produces a findings report; fixes go through the normal test-first → `/review` → `ship-pr` loop.
- **Planning work** → `plan-feature` skill for a normal feature/fix (plan → confirm → code). Durable
  design docs live in **Confluence ADRs**, not a local folder.
- **Sanity-checking a design** → `principal-architect` agent (MVP-to-scale, cost→perf→AI, boundaries).
- **Investigating a failure** → `triage-error` skill (forked context, root-cause summary).
- **Writing tests** → `test-writer` agent; running them → `run-tests` skill.
- **Touching the theme system** → `theme-change` skill (the invariants). **Shipping** → `ship-pr` skill.

## Plugins (org shared standards + tooling)

`settings.json` enables the org's `gokwik-ops-hub` marketplace plugins — the same set peer repos use:

- **`gokwik-eng-standards`** — org-wide engineering standards (baseline git-workflow + security rules,
  safety hooks). Layers _under_ our inline `rules/` — ours are ratio-tailored (theme invariants,
  two-engine parity, the test incantation) and are the source of truth for this repo; the plugin adds
  the generic org baseline. Some overlap is expected and harmless.
- **`gokwik-code-search`** — semantic code + docs search (MCP).
- **`gokwik-dev-context-generators`** — dev context generators.

**The marketplace must be registered once** for these to activate. Either add it by hand
(`/plugin marketplace add <gokwik-ops-hub source>` — ask your team for the source repo), or auto-register
it by adding `extraKnownMarketplaces` to `settings.json` so anyone who trusts the folder gets it (fill in
the real org/repo):

```json
"extraKnownMarketplaces": {
  "gokwik-ops-hub": { "source": { "source": "github", "repo": "<org>/<repo>" } }
}
```

Either way you then run `claude plugin install` (registering no longer auto-installs external-source
plugins). The committed `enabledPlugins` block only _declares_ the dependency; without the marketplace
installed the plugins are inert and the inline `.claude/` config still works fully on its own. Peer repos
(`kwikcart-be`) also pre-approve plugin MCP tools (Signoz observability, service-resolver) in their
personal `settings.local.json` — add those to yours if you use them.

## Hooks (wired in `settings.json`)

All hooks read the tool payload from **stdin** (Claude Code does not set a `CLAUDE_TOOL_INPUT` env var);
env vars like `CLAUDE_PROJECT_DIR` are available.

- `SessionStart` → `load-context.sh` — injects branch + recent commits + status so sessions open oriented
  (also cleans stale `.knowledge-checked-*` sentinels).
- `PreToolUse:Bash` → `guard.sh` — blocks `git add -A`/`.`, force-push, deploys, broad `rm -rf`, and
  hardcoded-secret patterns (exit 2). Escape hatch: export `CLAUDE_SKIP_GUARD=1` **before** launching claude.
- `PostToolUse:Edit|Write|MultiEdit` → `format-on-edit.sh` — Prettier on the edited file.
- `Stop` → `debug-check.sh` (warns on `console.log`/`debugger` added vs HEAD) + `knowledge-nudge.sh`
  (once/session, if files changed, nudges a `context/`/`mistakes.md` update). Sentinel
  `.claude/.knowledge-checked-*` is git-ignored.

## Precedence & how it's used

- `CLAUDE.md` + `rules/` are the always-on context. Keep them tight and true.
- `context/` is reference — linked from `CLAUDE.md`; read the relevant page before a non-trivial change.
- `skills/` activate by their frontmatter `description`, so write descriptions as "use when …".
- `settings.json` (shared) is merged with `settings.local.json` (personal); the local file wins for that
  developer. Team-wide rules/hooks go in `settings.json`; personal prefs go in `settings.local.json`.

## The maintenance process — how to add / update

Treat this folder like code: **source is canonical**. If config disagrees with the code, the code is
right — fix the config. Prefer editing an existing file over adding a new one. No secrets, ever.

- **Add a rule** → new `rules/<topic>.md` (plain markdown, one topic). If it's core behavior, add a
  one-line pointer in `CLAUDE.md`'s non-negotiables.
- **Add an agent** → `agents/<name>.md` with frontmatter `name`, `description` (start "Use to/when …"),
  `tools`, `model`. Keep the checklist repo-specific.
- **Add a skill** → `skills/<name>/SKILL.md` with frontmatter `name` + `description`. The description is
  what triggers auto-activation — make it a precise "use when …".
- **Add a slash command** → `commands/<name>.md` with frontmatter `description` + optional
  `argument-hint`. `$ARGUMENTS` holds the args. Invoked as `/<name>`.
- **Add a hook** → put the script in `hooks/`, `chmod +x`, **test it manually** with a sample
  `CLAUDE_TOOL_INPUT` (see `guard.sh`), then wire it in `settings.json` under
  `PreToolUse` / `PostToolUse` / `Stop` with the right `matcher`. Keep inline hook commands short;
  anything non-trivial goes in a script.
- **Update context** → edit the relevant `context/NN-*.md` when architecture, conventions, integrations,
  or the roadmap change. One source of truth per topic — don't fork parallel docs.
- **Log a mistake** → after a non-obvious mistake, append one line (mistake + fix) to `mistakes.md`, and
  promote it to `context/06-gotchas.md` if it's a recurring landmine.
- **Change permissions/hooks** → edit `settings.json` (shared) for team-wide changes; `settings.local.json`
  (personal, git-ignored) for your own. `deny` beats `allow`. `.env*` stays denied.

### When to update (triggers)

- After merging a change that alters architecture, a public contract, a convention, or the render/theme
  flow → update `CLAUDE.md` / `context/` / the relevant rule.
- After the roadmap moves (a story done, a new epic, a changed "next pick") → update
  `context/07-roadmap-and-state.md`.
- After hitting a non-obvious gotcha → `mistakes.md` (+ `context/06-gotchas.md` if recurring).
- When a workflow gets repeated by hand ≥3 times → capture it as a `skill` or `command`.

### Quality bar

- Tailored to _this_ repo, not generic boilerplate (that's the whole point).
- Accurate and current — stale guidance is worse than none. Verify against the code before writing.
- Concise and skimmable. Plain, simple English.
- No secrets: reference env-var **names**, never values.

## Related

- Product/architecture reference for humans + Claude: `context/README.md` (the handbook index).
- The behavioral non-negotiables are summarized at the bottom of `../CLAUDE.md`.
