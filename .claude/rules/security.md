# Rule: Security

## Secrets

- Never hardcode API keys, tokens, passwords, or connection strings in source.
- **Never read, log, or echo `.env` files** (also enforced in `.claude/settings.json` deny list). When
  documenting config, reference the env-var **name**; values live in `.env` (local) or CI repo
  variables (deployed). Exclude `.env*` from greps.
- If you discover a secret committed in the code, **stop and flag it** before continuing.

## Input handling (validate at boundaries, trust internal code)

- Treat anything from a user, the AI, the network, a merchant's theme/Liquid, or an external API as
  **untrusted**. Sanitize before it reaches shell, SQL, HTML, or a Liquid render.
- Untrusted **merchant Liquid renders in a worker isolate** (`builder-render/worker.mjs`), never
  in-process. Keep it that way.
- Enforce new invariants at the **route boundary** (untrusted merchant/AI input), not the low-level
  `ThemeStore` primitive — internal flows (onboarding adopt, rebase) are trusted and produce valid data
  by construction; guarding the primitive breaks them.
- Reject obviously malformed input early; don't "fix and continue".

## Storefront safety

- The storefront CSP is `script-src 'none'` — storefront pages carry no first-party JS. CSS is the
  theme's (inline `<style>`); it's neutralized against `</style>` breakout. Don't weaken these.
- Content-type allowlist + content-hash addressing guard the asset store (stored-XSS defense). Serve
  assets `nosniff` + immutable.

## Review focus for AI-written code

Prioritize: auth/authorization assumptions, error boundaries (what they swallow — infra faults must
surface as 500, not a misleading user-facing 400), injection surfaces (shell/SQL/Liquid/prompt), secret
handling, and rollout/migration risk.
