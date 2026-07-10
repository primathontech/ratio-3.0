# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for security problems. Report privately via GitHub
Security Advisories (repo → Security → Report a vulnerability), or email the
maintainers. We aim to acknowledge within 2 business days.

## Handling

- Secrets are never committed (`.env` is git-ignored; only `.env.example` is tracked).
- Per-tenant credentials live in a secrets manager, decrypted in-memory only (ADR-001 D-MT4 / ADR-010).
- Tenant isolation is deny-by-default and covered by tests (`test/repo.test.ts`, `test/origin.test.ts`).
- Dependencies are watched by Dependabot; CI runs `npm audit` (fails on high severity).
