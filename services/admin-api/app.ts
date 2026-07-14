import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  onboardStore,
  deleteStore,
  listDomains,
  addDomain,
  removeDomain,
  ConflictError,
} from '../../packages/provisioning/index';
import { forTenant } from '../../packages/repo/index';
import { cfConfig, connectCustomHostname, customHostnameStatus, purgeUrls } from './domains';
import {
  authMiddleware,
  requireMembership,
  listStoresForUser,
  listAllStores,
  isPlatformAdmin,
  clerkVerifier,
  agentVerifier,
  composeVerifiers,
  mintAgentToken,
  denyNarrowedScope,
  type Verifier,
} from './auth';
import { auditMiddleware, recentAudit } from './audit';
import { openApiDocument } from './openapi';
import { createRateLimiter } from '../../packages/shared/ratelimit';
import Anthropic from '@anthropic-ai/sdk';
import { RatioControlPlane } from '@ratio/control-plane-client';
import { runAssistant, scopeForAssistant } from './assistant';

// Ratio CONTROL PLANE (ADR-014): the authenticated API the admin portal + AI agent
// both drive. Data plane (edge + origin) is separate and public; this is the write path.
// Auth is ADR-010: Clerk verifies identity, our memberships table authorizes per store.
// createApp takes the verifier so tests can inject identity without calling Clerk. The
// default accepts both human Clerk sessions and ADR-007 agent tokens on the same surface.
type Vars = { Variables: { userId: string; scope?: string[]; auditTenant?: string } };

export interface AppOptions {
  rateLimit?: number; // per-user requests/min on the control plane
  assistantRateLimit?: number; // tighter per-user budget on /assistant
}

export function createApp(
  verify: Verifier = composeVerifiers(agentVerifier, clerkVerifier),
  opts: AppOptions = {}
) {
  const app = new Hono<Vars>();

  // Per-user rate limits (OFCE-406 / audit M-1). In-memory per process — fine for the
  // single-container admin-api; a multi-instance deploy needs a shared store. /assistant
  // gets a much tighter budget because each call fans out to several Anthropic requests.
  const rl = createRateLimiter({ limit: opts.rateLimit ?? 300, windowMs: 60_000 });
  const assistantRl = createRateLimiter({ limit: opts.assistantRateLimit ?? 20, windowMs: 60_000 });

  // The admin SPA lives on a different origin (Cloudflare Pages) and calls this API from
  // the browser with a Bearer token, so it needs CORS. Lock to ADMIN_CORS_ORIGIN in prod
  // (comma-separated allowed origins); '*' only as a dev default. Runs before auth so
  // preflight OPTIONS isn't rejected by the 401 gate.
  const origins = (process.env.ADMIN_CORS_ORIGIN || '*').split(',').map((o) => o.trim());
  app.use('*', cors({ origin: origins.length === 1 ? origins[0] : origins }));

  app.use('*', authMiddleware(verify, ['/health', '/', '/openapi.json']));
  // Throttle per authenticated user (after auth so userId is known; public paths have none
  // and pass through). /assistant draws from its own tighter bucket.
  app.use('*', async (c, next) => {
    const userId = c.get('userId');
    if (!userId) return next();
    const limiter = c.req.path === '/assistant' ? assistantRl : rl;
    if (!limiter.check(userId).allowed) {
      return c.json({ error: 'rate limit exceeded — retry shortly' }, 429);
    }
    return next();
  });
  // Audit every authenticated mutation (ADR-016 Phase 1). After auth so the actor is known.
  app.use('*', auditMiddleware);
  // A conflict is a client-actionable 409. Everything else that reaches here is an
  // UNEXPECTED throw (bad input is validated at the route with an explicit 400) → 500, and
  // in production we return a generic message so DB/vendor error strings don't leak to the
  // browser. Detail stays server-side (dev keeps it for debuggability).
  app.onError((e, c) => {
    if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
    const detail = process.env.NODE_ENV === 'production' ? 'internal error' : e.message;
    return c.json({ error: detail }, 500);
  });

  // Public liveness root — the ECS Express gateway health-checks GET / and expects 200.
  app.get('/', (c) => c.json({ service: 'ratio-admin-api', status: 'ok' }));
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // The API contract (ADR-016), source of truth for the generated SDK. Public so tooling
  // and dev portals can read it without a token.
  app.get('/openapi.json', (c) => c.json(openApiDocument));

  // Who am I — also surfaces the caller's Clerk id (for PLATFORM_ADMIN_IDS setup).
  app.get('/me', (c) => {
    const userId = c.get('userId');
    return c.json({ userId, isPlatformAdmin: isPlatformAdmin(userId) });
  });

  // The stores the signed-in user may manage (drives the admin portal's home screen).
  // Platform admins see every store; everyone else sees only their memberships.
  app.get('/stores', async (c) => {
    const userId = c.get('userId');
    const stores = isPlatformAdmin(userId)
      ? await listAllStores()
      : await listStoresForUser(userId);
    return c.json({ stores });
  });

  // Create a store. The authenticated caller becomes its owner — the membership is
  // written in the same transaction as the tenant, so a store always has an owner.
  app.post('/stores', denyNarrowedScope, async (c) => {
    const { id, name, host, color } = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      host?: string;
      color?: string;
    };
    if (!id || !name || !host) {
      return c.json({ error: 'id, name and host are required' }, 400);
    }
    if (color !== undefined && !/^#[0-9a-f]{3,8}$/i.test(color)) {
      return c.json({ error: 'color must be a hex value like #4f46e5' }, 400);
    }
    await onboardStore({ id, name, host, color, ownerUserId: c.get('userId') });
    if (id) c.set('auditTenant', id); // onboarding: the store id is in the body, not the path
    return c.json({ id, url: `https://${host}/` }, 201);
  });

  // Read a store — caller must have a membership on it.
  app.get('/stores/:id', requireMembership, async (c) => {
    const tenant = await forTenant(c.req.param('id')).getTenant();
    if (!tenant) return c.json({ error: 'not found' }, 404);
    return c.json({ id: tenant.id, name: tenant.name, theme: tenant.theme });
  });

  // Provably-complete hard-delete (ADR-010 D-SEC4) — caller must have a membership.
  app.delete('/stores/:id', requireMembership, async (c) => {
    const proof = await deleteStore(c.req.param('id'));
    return c.json(proof);
  });

  // Mint a short-lived agent token scoped to THIS store (ADR-007 / OFCE-399), so the owner
  // can delegate the AI agent access to the same API. Membership-gated; scope is exactly
  // this tenant and inherits the caller's principal — it can only narrow, never widen.
  app.post('/stores/:id/agent-tokens', requireMembership, (c) => {
    const expiresIn = 3600;
    const token = mintAgentToken({
      sub: c.get('userId'),
      scope: [c.req.param('id')],
      exp: Math.floor(Date.now() / 1000) + expiresIn,
    });
    return c.json({ token, scope: [c.req.param('id')], expiresIn }, 201);
  });

  // OFCE-400 Model A: in-dashboard AI assistant. Claude runs a server-side tool-use loop
  // and drives the SAME control-plane the dashboard uses — not a forked code path (ADR-014
  // D-STR7). We mint a merchant-scoped agent token for the signed-in caller and route the
  // SDK's fetch back at THIS app in-process, so the assistant's edits run through the same
  // auth, membership, and audit as everything else. ANTHROPIC_API_KEY stays server-side.
  const viaSelf: typeof fetch = ((url: string | URL | Request, init?: RequestInit) =>
    app.fetch(new Request(url as string, init))) as typeof fetch;

  app.post('/assistant', denyNarrowedScope, async (c) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return c.json({ error: 'AI assistant is not configured (ANTHROPIC_API_KEY missing).' }, 503);
    }
    const { message, storeId } = (await c.req.json().catch(() => ({}))) as {
      message?: string;
      storeId?: string;
    };
    if (!message || !message.trim()) return c.json({ error: 'message is required' }, 400);

    // Least privilege (N1): scope the token to the open store when there is one; only the
    // onboarding entry point (no storeId) gets '*' so it can create a brand-new store.
    const token = mintAgentToken({
      sub: c.get('userId'),
      scope: scopeForAssistant(storeId),
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    const client = new RatioControlPlane({
      baseUrl: new URL(c.req.url).origin,
      token,
      fetch: viaSelf,
    });
    const result = await runAssistant({
      anthropic: new Anthropic(),
      client,
      message,
      storeId,
    });
    return c.json(result);
  });

  // Recent control-plane changes for a store (ADR-016 Phase 1 audit trail) — powers the
  // dashboard's "Recent changes". Membership-gated; a read, so not itself audited.
  app.get('/stores/:id/audit', requireMembership, async (c) => {
    const entries = await recentAudit(c.req.param('id'));
    return c.json({ entries });
  });

  // --- Content CRUD (OFCE-362 slice 2). All membership-gated. The storefront renders
  // whatever page_config lives here, so editing a page changes the live store. ---

  app.get('/stores/:id/pages', requireMembership, async (c) => {
    const pages = await forTenant(c.req.param('id')).listRoutes();
    return c.json({ pages });
  });

  app.get('/stores/:id/page', requireMembership, async (c) => {
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'path query param required' }, 400);
    const route = await forTenant(c.req.param('id')).getRoute(path);
    if (!route) return c.json({ error: 'not found' }, 404);
    return c.json({ path: route.path, pageType: route.page_type, pageConfig: route.page_config });
  });

  app.put('/stores/:id/page', requireMembership, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      path?: string;
      pageType?: string;
      pageConfig?: unknown;
    };
    if (!body.path || !body.path.startsWith('/')) {
      return c.json({ error: 'path is required and must start with /' }, 400);
    }
    if (typeof body.pageConfig !== 'object' || body.pageConfig === null) {
      return c.json({ error: 'pageConfig must be an object' }, 400);
    }
    const pageType = body.pageType || 'page';
    const id = c.req.param('id');
    await forTenant(id).addRoute(body.path, pageType, body.pageConfig);
    // Make the edit go live: purge the edge cache for this route on every real domain
    // (OFCE-411). Best-effort and non-blocking — a purge failure must not fail the save.
    const cfg = cfConfig();
    if (cfg) {
      const urls = (await listDomains(id))
        .filter((h) => !h.endsWith('.localhost'))
        .map((h) => `https://${h}${body.path}`);
      void purgeUrls(cfg, urls).catch(() => {});
    }
    return c.json({ path: body.path, pageType, pageConfig: body.pageConfig });
  });

  // --- Custom domains (OFCE-398 / ADR-013). Membership-gated. Cloudflare-for-SaaS
  // custom hostnames; platform *.ratiodev.in subdomains are already live via wildcard. ---

  const isPlatformHost = (h: string) => h.endsWith('.ratiodev.in') || h.endsWith('.localhost');

  app.get('/stores/:id/domains', requireMembership, async (c) => {
    const hosts = await listDomains(c.req.param('id'));
    const cfg = cfConfig();
    const domains = await Promise.all(
      hosts.map(async (host) => {
        if (isPlatformHost(host))
          return { host, kind: 'platform', status: 'active', sslStatus: 'active' };
        if (!cfg)
          return { host, kind: 'custom', status: 'unconfigured', sslStatus: 'unconfigured' };
        const s = await customHostnameStatus(cfg, host).catch(() => null);
        return {
          host,
          kind: 'custom',
          status: s?.status ?? 'pending',
          sslStatus: s?.sslStatus ?? 'unknown',
        };
      })
    );
    return c.json({ domains });
  });

  // Connect a merchant's own domain: map it to the tenant + create the CF custom hostname,
  // and return the DNS records the merchant must add at their registrar.
  app.post('/stores/:id/domains', requireMembership, async (c) => {
    const { host } = (await c.req.json().catch(() => ({}))) as { host?: string };
    if (!host || !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)) {
      return c.json({ error: 'a valid domain is required' }, 400);
    }
    // Platform subdomains (*.ratiodev.in) are assigned at onboarding, never connected as a
    // "custom domain" — otherwise a merchant could squat an unclaimed platform subdomain.
    if (isPlatformHost(host.toLowerCase())) {
      return c.json({ error: 'platform subdomains cannot be connected as a custom domain' }, 400);
    }
    await addDomain(c.req.param('id'), host.toLowerCase());
    const cfg = cfConfig();
    if (!cfg) {
      return c.json(
        {
          host,
          configured: false,
          note: 'Domain mapped. Set CLOUDFLARE_API_TOKEN on the API to enable SSL/custom-hostname provisioning.',
        },
        201
      );
    }
    try {
      const conn = await connectCustomHostname(cfg, host.toLowerCase());
      return c.json({ ...conn, configured: true }, 201);
    } catch (e) {
      return c.json({ host, configured: true, error: (e as Error).message }, 502);
    }
  });

  app.delete('/stores/:id/domains', requireMembership, async (c) => {
    const { host } = (await c.req.json().catch(() => ({}))) as { host?: string };
    if (!host) return c.json({ error: 'host is required' }, 400);
    const removed = await removeDomain(c.req.param('id'), host);
    return c.json({ removed });
  });

  // The DNS records + status for ONE domain — so a merchant can pull the setup details
  // back up anytime. Creates the custom hostname if it wasn't provisioned yet (e.g. the
  // domain was mapped before the Cloudflare token was configured).
  app.get('/stores/:id/domain', requireMembership, async (c) => {
    const host = c.req.query('host');
    if (!host) return c.json({ error: 'host query param required' }, 400);
    if (isPlatformHost(host)) {
      return c.json({
        host,
        configured: true,
        kind: 'platform',
        status: 'active',
        sslStatus: 'active',
        records: [],
      });
    }
    const cfg = cfConfig();
    if (!cfg)
      return c.json({
        host,
        configured: false,
        note: 'Custom domains are not configured on this server.',
      });
    try {
      const conn =
        (await customHostnameStatus(cfg, host)) ?? (await connectCustomHostname(cfg, host));
      return c.json({ ...conn, configured: true });
    } catch (e) {
      return c.json({ host, configured: true, error: (e as Error).message }, 502);
    }
  });

  return app;
}

export const app = createApp();
