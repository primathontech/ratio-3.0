# Ratio Admin (control plane) — planned

The merchant-facing dashboard (create store, edit content/theme, connect a custom
domain, view basics). It is a **thin client over `apps/admin-api`** — no
business logic here; it calls the authenticated API.

Status: **scaffold** (OFCE-362). The control-plane API exists (`apps/admin-api`);
the UI is the next slice. The AI agent (ADR-007) drives the _same_ API.
