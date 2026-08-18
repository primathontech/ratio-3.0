# Ratio 3.0 — Developer Context Pack

Start here. This folder is the handoff pack: everything a new developer needs to understand what
this project is, how it's built, how to run and test it, and how to write code that fits and merges.
Read in order; each file is self-contained.

| #   | File                                                       | What it covers                                                   |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | [01-project-overview.md](01-project-overview.md)           | What Ratio 3.0 is, the product bet, current state                |
| 2   | [02-architecture.md](02-architecture.md)                   | Edge → origin → admin-api → admin-web, data stores, request flow |
| 3   | [03-local-dev-and-testing.md](03-local-dev-and-testing.md) | Run it locally, the exact test incantation, ports, env           |
| 4   | [04-conventions.md](04-conventions.md)                     | Coding/testing/git rules, PR workflow, decision priorities       |
| 5   | [05-theme-system.md](05-theme-system.md)                   | The bundle theme system (the core domain, most active area)      |
| 6   | [06-gotchas.md](06-gotchas.md)                             | The landmines — read before touching render/theme/CI             |
| 7   | [07-roadmap-and-state.md](07-roadmap-and-state.md)         | Epics, what's done, what's next (OFCE-641 go-live)               |
| 8   | [08-external-integrations.md](08-external-integrations.md) | Jira/Confluence, GoKwik commerce, MCP servers, test merchant     |

## The 60-second version

Ratio 3.0 ("OpenStore") is a **re-platform** of a Shopify-like storefront system: **"Shopify for
India — cheaper, ultra-fast, AI-native."** It's a **multi-tenant** commerce front-end where each
merchant's storefront is rendered from a **theme bundle** (Liquid files + assets, stored in S3,
composed as `base ⊕ per-store overrides`). A **Cloudflare edge** worker serves cached pages and
proxies to a **Hono origin** (containers) that renders the theme; an **admin-api** + **admin-web SPA**
let merchants edit and publish themes; **Postgres** is the tenant/theme system of record.

- **Monorepo**, bun workspaces: `apps/*` (edge, origin, admin-api, admin-web) + `packages/*`
  (builder-core, builder-render, data-_, edge-core, gokwik, observability-_).
- **Test-first, real infra**: tests run against a real Postgres (docker :5433) + MinIO (S3, :9000),
  no DB mocks. `node:test` runner.
- **Pre-launch / staging** — no real production traffic yet. Move fast; don't apply prod-grade caution.
- **Commerce data** (products/cart/orders) comes from an **external GoKwik backend**, not our DB.

## Non-negotiables (see 04-conventions.md for the full list)

- **Never commit/push without explicit approval.** Write + test + show the diff, then ask.
- **Never `git add -A`** — stage specific paths (someone else's WIP can be swept in).
- **Reproduce a reported bug with a failing test first**, then fix.
- **Self-review every PR** (run the code-review + fix findings) before asking for merge.
- **Never read/echo `.env`** or hardcode secrets. Config is env-var _names_; values live in `.env`
  (local) or CI repo variables (deployed).
