import { serve } from '@hono/node-server';
import { app } from './app';

// Control-plane API entrypoint (its own deploy — separate from the data plane).
// Fail fast: agent tokens (ADR-007) can't be minted or verified without this, and the
// assistant would 503 — refuse to boot in production without it rather than run degraded.
if (process.env.NODE_ENV === 'production' && !process.env.AGENT_TOKEN_SECRET) {
  throw new Error('AGENT_TOKEN_SECRET must be set in production');
}
// Never serve the control plane with wildcard CORS in production — require an explicit
// origin allowlist (the app default of '*' is dev-only).
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_CORS_ORIGIN) {
  throw new Error('ADMIN_CORS_ORIGIN must be set in production');
}

const PORT = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () =>
  console.log(`control-plane API → 0.0.0.0:${PORT}`)
);
