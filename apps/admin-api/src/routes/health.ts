// Liveness / readiness / contract / whoami. The first four are PUBLIC (the auth middleware exempts
// /, /health, /ready, /openapi.json); /me requires a session. Split out of app.ts per app.route().
import { Hono } from 'hono';
import { isPlatformAdmin } from '../auth';
import { openApiDocument } from '../openapi';
import { config } from '../config';
import type { Vars } from '../types';

export interface HealthDeps {
  readiness: () => Promise<boolean>;
}

export function healthRoutes(deps: HealthDeps): Hono<Vars> {
  const { readiness } = deps;
  const r = new Hono<Vars>();

  // Public liveness root — the ECS Express gateway health-checks GET / and expects 200.
  r.get('/', (c) => c.json({ service: 'ratio-admin-api', status: 'ok' }));
  r.get('/health', (c) => c.json({ status: 'ok' }));
  // Readiness (vs liveness /health): probe the DB so an orchestrator doesn't route traffic to an
  // instance that can't reach Postgres. Pre-auth so probes need no credentials (L-7).
  r.get('/ready', async (c) => {
    const ok = await readiness();
    return c.json({ status: ok ? 'ready' : 'unavailable' }, ok ? 200 : 503);
  });

  // The API contract (ADR-016), source of truth for the generated SDK. Public so tooling and dev
  // portals can read it without a token.
  r.get('/openapi.json', (c) => c.json(openApiDocument));

  // Who am I — also surfaces the caller's Clerk id (for PLATFORM_ADMIN_IDS setup).
  r.get('/me', (c) => {
    const userId = c.get('userId');
    // isLocal (RATIO_LOCAL) lets the SPA show dev-only affordances — e.g. a local storefront link
    // via the edge's ?store=<id> override — driven by the one run-environment flag, not a guess.
    return c.json({ userId, isPlatformAdmin: isPlatformAdmin(userId), isLocal: config.local });
  });

  return r;
}
