# packages/edge-provider — the control-plane edge seam

admin-api touches the edge in two places: it write-throughs the `host→tenant` routing map, and it
provisions per-merchant custom hostnames + TLS. Both are platform-specific. This package puts them
behind **one `EdgeProvider` interface** (`types.ts`) with per-platform implementations:

- `cloudflare.ts` — Workers KV REST + Cloudflare for SaaS (consolidates the existing
  `services/admin-api/domains.ts` logic).
- `akamai.ts` — EdgeKV writes + CPS custom-hostname automation (OFCE-477).

admin-api picks one by config instead of hard-coding a vendor, so switching the edge doesn't touch
the control-plane logic. Both files are scaffolds today (throw "not implemented"); wiring admin-api
onto the interface is a follow-up refactor.
