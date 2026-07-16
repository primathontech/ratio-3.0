import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import {
  onboardStore,
  deleteStore,
  listDomains,
  addDomain,
  removeDomain,
  markDomainVerified,
  markDomainConnected,
  ConflictError,
} from '../../packages/provisioning/index';
import { forTenant, StaleWriteError } from '../../packages/repo/index';
import { pool } from '../../packages/shared/db';
import {
  cfConfig,
  connectCustomHostname,
  customHostnameStatus,
  deleteCustomHostname,
  purgeUrls,
  storeCacheUrls,
  kvConfig,
  publishTenantMapping,
  unpublishTenantMapping,
} from './domains';
import {
  authMiddleware,
  csrfGuard,
  requireMembership,
  requireRole,
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
import { createPgRateLimiter } from '../../packages/shared/ratelimit';
import {
  createPgIdempotencyStore,
  idempotencyKeyFor,
  IdempotencyInProgressError,
} from './idempotency';
import { createReadiness } from './readiness';
import Anthropic from '@anthropic-ai/sdk';
import { RatioControlPlane } from '@ratio/control-plane-client';
import { runAssistant, scopeForAssistant } from './assistant';

// Ratio CONTROL PLANE (ADR-014): the authenticated API the admin portal + AI agent
// both drive. Data plane (edge + origin) is separate and public; this is the write path.
// Auth is ADR-010: Clerk verifies identity, our memberships table authorizes per store.
// createApp takes the verifier so tests can inject identity without calling Clerk. The
// default accepts both human Clerk sessions and ADR-007 agent tokens on the same surface.
type Vars = { Variables: { userId: string; scope?: string[]; auditTenant?: string } };

// Reserved platform labels: infra + auth surfaces that must never be self-served on the
// platform's own domain (H-1 — subdomain squat: e.g. login.ratiodev.in served attacker
// content on Ratio's trusted domain). Merchants may take any OTHER single-label
// *.ratiodev.in; the apex, multi-label, and these labels are platform-admin-only.
const RESERVED_PLATFORM_LABELS = new Set([
  'www',
  'api',
  'admin',
  'app',
  'apps',
  'login',
  'logout',
  'signin',
  'signup',
  'auth',
  'account',
  'accounts',
  'mail',
  'smtp',
  'imap',
  'pop',
  'ftp',
  'ns',
  'ns1',
  'ns2',
  'dns',
  'mx',
  'cdn',
  'assets',
  'static',
  'media',
  'img',
  'images',
  'files',
  'downloads',
  'dashboard',
  'portal',
  'console',
  'support',
  'help',
  'status',
  'docs',
  'blog',
  'store',
  'shop',
  'dev',
  'staging',
  'stage',
  'test',
  'qa',
  'preview',
  'internal',
  'root',
  'ratio',
  'ratiodev',
  'billing',
  'pay',
  'payments',
]);
const PLATFORM_SUFFIX = '.ratiodev.in';

// Whether a merchant may self-serve this host at onboarding. Custom domains pass through
// (host-ownership is guarded separately). Platform hosts are limited to a single
// non-reserved label; the apex, multi-label, and reserved labels require a platform admin.
export function platformSubdomainAllowed(host: string, isAdmin: boolean): boolean {
  const h = (host || '').toLowerCase();
  const isPlatform = h === 'ratiodev.in' || h.endsWith(PLATFORM_SUFFIX);
  if (!isPlatform) return true; // custom domain — not our subdomain space
  if (isAdmin) return true; // ops assign platform hosts (login., www., the apex, …)
  if (h === 'ratiodev.in') return false; // apex
  const sub = h.slice(0, -PLATFORM_SUFFIX.length);
  if (sub.includes('.')) return false; // only single-label subdomains are self-served
  return !RESERVED_PLATFORM_LABELS.has(sub);
}

export interface AppOptions {
  rateLimit?: number; // per-user requests/min on the control plane
  assistantRateLimit?: number; // tighter per-user budget on /assistant
  internalToken?: string; // marks in-process (viaSelf) calls so they skip the limiter (tests inject)
}

export function createApp(
  verify: Verifier = composeVerifiers(agentVerifier, clerkVerifier),
  opts: AppOptions = {}
) {
  const app = new Hono<Vars>();

  // Per-user rate limits (OFCE-406 / audit M-1). In-memory per process — fine for the
  // single-container admin-api; a multi-instance deploy needs a shared store. /assistant
  // gets a much tighter budget because each call fans out to several Anthropic requests.
  // Shared (Postgres-backed) so the limit holds across admin-api instances (H-1). Keys are
  // namespaced per bucket so the general and /assistant counters don't collide for one user.
  const rl = createPgRateLimiter(pool, { limit: opts.rateLimit ?? 300, windowMs: 60_000 });
  const assistantRl = createPgRateLimiter(pool, {
    limit: opts.assistantRateLimit ?? 20,
    windowMs: 60_000,
  });
  // Dedupe /assistant runs by idempotency key (OFCE-412).
  // Shared (Postgres-backed) so dedup + single-execution hold across admin-api instances (H-1).
  const idem = createPgIdempotencyStore(pool);
  // Cached DB readiness probe (L1): /ready is public + limiter-exempt, so cache the query.
  const readiness = createReadiness(() => pool.query('SELECT 1').then(() => undefined));
  // Unforgeable per-process marker for the assistant's in-process (viaSelf) sub-requests, so
  // they skip the per-user limiter (L-1) — otherwise one assistant run's fan-out drained the
  // caller's own budget and rate-limited itself. Random by default; never sent to clients.
  const internalToken = opts.internalToken ?? randomUUID();

  // The admin SPA lives on a different origin (Cloudflare Pages) and calls this API from
  // the browser with a Bearer token, so it needs CORS. Lock to ADMIN_CORS_ORIGIN in prod
  // (comma-separated allowed origins); '*' only as a dev default. Runs before auth so
  // preflight OPTIONS isn't rejected by the 401 gate.
  const origins = (process.env.ADMIN_CORS_ORIGIN || '*').split(',').map((o) => o.trim());
  app.use('*', cors({ origin: origins.length === 1 ? origins[0] : origins }));
  // Cap request bodies so a member can't PUT a multi-MB pageConfig (storage/render abuse) or
  // exhaust memory (L11). 1 MB is generous for a page document.
  app.use(
    '*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: 'request body too large' }, 413),
    })
  );

  app.use('*', authMiddleware(verify, ['/health', '/ready', '/', '/openapi.json']));
  // Reject cross-site cookie-authenticated mutations (I-1). After auth so a bad session 401s
  // first; before mutations run.
  app.use('*', csrfGuard(origins));
  // Throttle per authenticated user (after auth so userId is known; public paths have none
  // and pass through). /assistant draws from its own tighter bucket.
  app.use('*', async (c, next) => {
    const userId = c.get('userId');
    if (!userId) return next();
    // In-process assistant fan-out (viaSelf) carries the unforgeable per-process marker and is
    // exempt — it's one user action, already throttled at the /assistant edge (L-1).
    if (c.req.header('x-ratio-internal') === internalToken) return next();
    const isAssistant = c.req.path === '/assistant';
    const limiter = isAssistant ? assistantRl : rl;
    const key = (isAssistant ? 'a:' : 'u:') + userId; // namespaced so the buckets don't collide
    if (!(await limiter.check(key)).allowed) {
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
    if (
      e instanceof ConflictError ||
      e instanceof StaleWriteError ||
      e instanceof IdempotencyInProgressError
    ) {
      return c.json({ error: e.message }, 409);
    }
    const detail = process.env.NODE_ENV === 'production' ? 'internal error' : e.message;
    return c.json({ error: detail }, 500);
  });

  // Public liveness root — the ECS Express gateway health-checks GET / and expects 200.
  app.get('/', (c) => c.json({ service: 'ratio-admin-api', status: 'ok' }));
  app.get('/health', (c) => c.json({ status: 'ok' }));
  // Readiness (vs liveness /health): probe the DB so an orchestrator doesn't route traffic
  // to an instance that can't reach Postgres. Pre-auth so probes need no credentials (L-7).
  app.get('/ready', async (c) => {
    const ok = await readiness();
    return c.json({ status: ok ? 'ready' : 'unavailable' }, ok ? 200 : 503);
  });

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
    // The id becomes the tenant_id — it flows into routing, cache-purge URLs, and agent-token
    // scopes (where '*' is the wildcard sentinel). Constrain it to a safe slug at the boundary.
    if (!/^[a-z][a-z0-9_-]{1,62}$/.test(id)) {
      return c.json(
        { error: 'id must be 2–63 chars: a lowercase letter, then letters, digits, _ or -' },
        400
      );
    }
    if (color !== undefined && !/^#[0-9a-f]{3,8}$/i.test(color)) {
      return c.json({ error: 'color must be a hex value like #4f46e5' }, 400);
    }
    // Host format at the boundary (H1) — symmetric with POST /stores/:id/domains. Blocks junk
    // domain rows in the global routing table. (This does NOT prove ownership of a custom
    // domain — squatting mitigation is a separate, verified-claim design; see OFCE backlog.)
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)) {
      return c.json({ error: 'host must be a valid domain like shop.example.com' }, 400);
    }
    // Hosts are case-insensitive; store + serve them lowercase so a mixed-case onboard
    // isn't a dead row the (lowercase) browser Host never matches (M-5).
    const lcHost = host.toLowerCase();
    // H-1: reserved/apex/multi-label platform subdomains are not self-serviceable — they'd
    // let a merchant serve content on Ratio's own trusted domain (phishing/brand). Ops
    // (platform admins) assign those; merchants get a single non-reserved *.ratiodev.in.
    if (!platformSubdomainAllowed(lcHost, isPlatformAdmin(c.get('userId')))) {
      return c.json({ error: 'that subdomain is reserved — choose another' }, 403);
    }
    const { hostReclaimedFrom } = await onboardStore({
      id,
      name,
      host: lcHost,
      color,
      ownerUserId: c.get('userId'),
    });
    if (id) c.set('auditTenant', id); // onboarding: the store id is in the body, not the path
    // Free a reclaimed host's stale CF custom hostname so the new owner can connect it (OFCE-422).
    const cfg = cfConfig();
    if (hostReclaimedFrom && cfg) await deleteCustomHostname(cfg, lcHost).catch(() => {});
    return c.json({ id, url: `https://${lcHost}/` }, 201);
  });

  // Read a store — caller must have a membership on it.
  app.get('/stores/:id', requireMembership, async (c) => {
    const tenant = await forTenant(c.req.param('id')).getTenant();
    if (!tenant) return c.json({ error: 'not found' }, 404);
    return c.json({ id: tenant.id, name: tenant.name, theme: tenant.theme });
  });

  // Provably-complete hard-delete (ADR-010 D-SEC4) — owner-only (M-4).
  app.delete('/stores/:id', requireRole('owner'), async (c) => {
    const id = c.req.param('id');
    const cfg = cfConfig();
    const kv = kvConfig();
    // Gather hosts (for cache + edge-KV cleanup) BEFORE the rows are purged.
    const hosts = cfg || kv ? await listDomains(id) : [];
    const urls = cfg
      ? storeCacheUrls(
          hosts,
          (await forTenant(id).listRoutes()).map((r) => r.path)
        )
      : [];
    const proof = await deleteStore(id);
    // Drop the deleted store's edge-KV mappings (S2 Decision #7). The origin also rejects a
    // missing tenant, so this is fast-path cleanup — best-effort.
    if (kv) for (const h of hosts) void unpublishTenantMapping(kv, h.toLowerCase()).catch(() => {});
    // Purge the edge cache so a hard-deleted store stops serving cached content immediately
    // (M-1) — completes the "provably complete" delete. Awaited so it's reportable.
    const cachePurged =
      cfg && urls.length ? await purgeUrls(cfg, urls).catch(() => false) : undefined;
    return c.json({ ...proof, cachePurged });
  });

  // Mint a short-lived agent token scoped to THIS store (ADR-007 / OFCE-399), so the owner
  // can delegate the AI agent access to the same API. Membership-gated; scope is exactly
  // this tenant and inherits the caller's principal — it can only narrow, never widen.
  app.post('/stores/:id/agent-tokens', requireRole('owner'), (c) => {
    // Only a first-party human session may mint (M5): letting an agent token mint fresh agent
    // tokens would defeat the short-lived guarantee — a single leaked token could renew itself
    // indefinitely. Agent tokens carry a scope; human Clerk sessions don't.
    if (c.get('scope')) {
      return c.json({ error: 'agent tokens cannot mint agent tokens' }, 403);
    }
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
  const viaSelf: typeof fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('x-ratio-internal', internalToken);
    return app.fetch(new Request(url as string, { ...init, headers }));
  }) as typeof fetch;

  app.post('/assistant', denyNarrowedScope, async (c) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return c.json({ error: 'AI assistant is not configured (ANTHROPIC_API_KEY missing).' }, 503);
    }
    const { message, storeId, idempotencyKey } = (await c.req.json().catch(() => ({}))) as {
      message?: string;
      storeId?: string;
      idempotencyKey?: string;
    };
    if (!message || !message.trim()) return c.json({ error: 'message is required' }, 400);

    // Dedupe by idempotency key (OFCE-412): a retry / refresh / double-submit re-uses the
    // first run instead of firing the tool loop again and duplicating stores/pages. A client
    // key (header or body) wins; otherwise fall back to a content-derived key (L-2) so callers
    // that send no key still get dedup on an identical resubmit. Scoped per user throughout.
    const rawKey = c.req.header('idempotency-key') || idempotencyKey;
    const idemKey = idempotencyKeyFor({
      userId: c.get('userId'),
      storeId,
      message,
      clientKey: rawKey,
    });

    const result = await idem.run(idemKey, () => {
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
      return runAssistant({ anthropic: new Anthropic(), client, message, storeId });
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
    return c.json({
      path: route.path,
      pageType: route.page_type,
      pageConfig: route.page_config,
      version: route.version,
    });
  });

  app.put('/stores/:id/page', requireMembership, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      path?: string;
      pageType?: string;
      pageConfig?: unknown;
      version?: number;
    };
    if (!body.path || !body.path.startsWith('/')) {
      return c.json({ error: 'path is required and must start with /' }, 400);
    }
    if (typeof body.pageConfig !== 'object' || body.pageConfig === null) {
      return c.json({ error: 'pageConfig must be an object' }, 400);
    }
    const pageType = body.pageType || 'page';
    const id = c.req.param('id');
    // Optimistic concurrency (OFCE-409): if the client sent the version it loaded, a stale
    // write (someone saved in between) → StaleWriteError → 409 via onError.
    const version = await forTenant(id).addRoute(
      body.path,
      pageType,
      body.pageConfig,
      body.version
    );
    // Make the edit go live: purge the edge cache for this route on every real domain
    // (OFCE-411). Best-effort and non-blocking — a purge failure must not fail the save.
    const cfg = cfConfig();
    if (cfg) {
      const urls = (await listDomains(id))
        .filter((h) => !h.endsWith('.localhost'))
        .map((h) => `https://${h}${body.path}`);
      void purgeUrls(cfg, urls).catch(() => {});
    }
    return c.json({ path: body.path, pageType, pageConfig: body.pageConfig, version });
  });

  // --- Custom domains (OFCE-398 / ADR-013). Membership-gated. Cloudflare-for-SaaS
  // custom hostnames; platform *.ratiodev.in subdomains are already live via wildcard. ---

  const isPlatformHost = (h: string) => h.endsWith('.ratiodev.in') || h.endsWith('.localhost');

  app.get('/stores/:id/domains', requireMembership, async (c) => {
    const id = c.req.param('id');
    const hosts = await listDomains(id);
    const cfg = cfConfig();
    // Which hosts are already verified — so we skip the redundant read-repair write on every
    // load once a domain is verified (L-2 write amplification).
    const verified = new Set(
      (
        await pool.query<{ host: string }>(
          'SELECT host FROM domains WHERE tenant_id = $1 AND verified = true',
          [id]
        )
      ).rows.map((r) => r.host)
    );
    const domains = await Promise.all(
      hosts.map(async (host) => {
        if (isPlatformHost(host))
          return { host, kind: 'platform', status: 'active', sslStatus: 'active' };
        if (!cfg)
          return { host, kind: 'custom', status: 'unconfigured', sslStatus: 'unconfigured' };
        const s = await customHostnameStatus(cfg, host).catch(() => null);
        // Read-repair: once Cloudflare reports the hostname active, DV succeeded → promote the
        // claim to verified. Skip the write if it's already verified (L-2). (H1)
        if (s?.status === 'active' && !verified.has(host)) {
          // Publish to the edge KV ONLY when the DB actually flipped verified for THIS tenant
          // (H1). markDomainVerified no-ops for a tenant that reclaimed the row but isn't its
          // connector; publishing on the CF status alone would route the host to a tenant
          // Postgres never verified — a cross-tenant hijack. Best-effort; the edge repopulates
          // on miss, so a failed push self-heals within the TTL.
          const nowVerified = await markDomainVerified(id, host);
          const kv = kvConfig();
          if (nowVerified && kv) void publishTenantMapping(kv, host, id).catch(() => {});
        }
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
  app.post('/stores/:id/domains', requireRole('owner'), async (c) => {
    const { host } = (await c.req.json().catch(() => ({}))) as { host?: string };
    if (!host || !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)) {
      return c.json({ error: 'a valid domain is required' }, 400);
    }
    // Platform subdomains (*.ratiodev.in) are assigned at onboarding, never connected as a
    // "custom domain" — otherwise a merchant could squat an unclaimed platform subdomain.
    if (isPlatformHost(host.toLowerCase())) {
      return c.json({ error: 'platform subdomains cannot be connected as a custom domain' }, 400);
    }
    const { reclaimedFrom } = await addDomain(c.req.param('id'), host.toLowerCase());
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
    // On a cross-tenant reclaim, delete the prior tenant's stale CF custom hostname so this
    // claimant can create their own and run DV — otherwise CF's one-object-per-host rule would
    // permanently block them (OFCE-422). Best-effort; a failure just surfaces as a connect error.
    if (reclaimedFrom) await deleteCustomHostname(cfg, host.toLowerCase()).catch(() => {});
    try {
      const conn = await connectCustomHostname(cfg, host.toLowerCase());
      // Bind verification to this tenant: only the connector can later be promoted to verified,
      // so a reclaim can't inherit another tenant's DV (R10-H1).
      await markDomainConnected(c.req.param('id'), host.toLowerCase());
      return c.json({ ...conn, configured: true }, 201);
    } catch (e) {
      // Don't leak raw Cloudflare error text to the merchant in production (L-1); log detail
      // server-side, return a generic message.
      if (process.env.NODE_ENV !== 'production') console.error('connectCustomHostname failed:', e);
      return c.json(
        {
          host,
          configured: true,
          error:
            process.env.NODE_ENV === 'production'
              ? 'could not reach the domain provider — please try again'
              : (e as Error).message,
        },
        502
      );
    }
  });

  app.delete('/stores/:id/domains', requireRole('owner'), async (c) => {
    const { host } = (await c.req.json().catch(() => ({}))) as { host?: string };
    if (!host) return c.json({ error: 'host is required' }, 400);
    const id = c.req.param('id');
    const removed = await removeDomain(id, host);
    // Drop the edge-KV mapping so the host stops resolving at the edge (S2 Decision #7).
    const kv = kvConfig();
    if (removed && kv) void unpublishTenantMapping(kv, host.toLowerCase()).catch(() => {});
    // Purge the removed host's cached pages so it stops serving after unmapping (M-1).
    const cfg = cfConfig();
    if (removed && cfg && !host.toLowerCase().endsWith('.localhost')) {
      const paths = (await forTenant(id).listRoutes()).map((r) => r.path);
      void purgeUrls(cfg, storeCacheUrls([host.toLowerCase()], paths)).catch(() => {});
    }
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
      // Don't leak raw Cloudflare error text to the merchant in production (L-1); log detail
      // server-side, return a generic message.
      if (process.env.NODE_ENV !== 'production') console.error('connectCustomHostname failed:', e);
      return c.json(
        {
          host,
          configured: true,
          error:
            process.env.NODE_ENV === 'production'
              ? 'could not reach the domain provider — please try again'
              : (e as Error).message,
        },
        502
      );
    }
  });

  return app;
}

export const app = createApp();
