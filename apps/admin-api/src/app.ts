import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { listDomains, ConflictError } from '@ratio/data-provisioning';
import { pool } from '@ratio/data-db';
import { resolveEdgeSecret } from '@ratio/edge-core';
import { config } from './config';
import { PageBuilder, type PurgeLike } from '@ratio/builder-core';
import { PgPageStore } from '@ratio/builder-core';
import { PgThemeStore } from '@ratio/builder-core';
import { storeSettingsRoutes } from './routes/store-settings';
import { storeRoutes } from './routes/stores';
import { pageBuilderRoutes } from './routes/page-builder';
import { domainsRoutes } from './routes/domains';
import { defaultRegistry } from '@ratio/builder-registry';
import { cfConfig, purgeUrls, storeCacheUrls } from './domains';
import {
  authMiddleware,
  csrfGuard,
  requireMembership,
  requireRole,
  isPlatformAdmin,
  clerkVerifier,
  insecureDevClerkVerifier,
  agentVerifier,
  composeVerifiers,
  mintAgentToken,
  denyNarrowedScope,
  type Verifier,
} from './auth';
import { auditMiddleware, recentAudit } from './audit';
import { openApiDocument } from './openapi';
import { createPgRateLimiter } from '@ratio/data-db';
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
import type { Vars } from './types';

// Purge a set of surrogate tags at the LOCAL dev edge (best-effort, RATIO_LOCAL-gated). The dev
// edge-sim indexes by tag; the deployed Cloudflare Worker does not (it 404s /__), so prod purge goes
// by URL via purgeStoreUrls below. Used by page-builder publish, theme-save, AND the commerce webhook.
async function purgeEdgeTags(tags: string[]): Promise<void> {
  if (!config.local || tags.length === 0) return;
  const port = process.env.EDGE_PORT || '8080';
  const secret = resolveEdgeSecret(process.env);
  for (const tag of tags) {
    await fetch(`http://127.0.0.1:${port}/__admin/purge?key=${encodeURIComponent(tag)}`, {
      headers: { 'x-admin-secret': secret },
    }).catch(() => {});
  }
}

// Prod edge purge BY URL (Cloudflare, plan-agnostic — Cache-Tag purge is Enterprise-only, so we
// purge the concrete URLs we know instead). Returns true/false when it ran, or null when there's no
// CF config (local dev — the dev edge-sim is purged separately via purgeEdgeTags). The caller RETURNS
// this so a failed purge is VISIBLE to the operator instead of being silently swallowed. Fine-grained
// product/collection purge (the webhook's prod:*/col:*) needs a tag→URL index and is deferred.
async function purgeStoreUrls(id: string, paths: string[]): Promise<boolean | null> {
  const cfg = cfConfig();
  if (!cfg) return null;
  const urls = storeCacheUrls(await listDomains(id), paths);
  if (urls.length === 0) return null;
  return purgeUrls(cfg, urls).catch(() => false);
}

// Page-builder authoring (draft -> publish, D4): publish purges by the EXACT surrogate tag the
// origin stamps on a page-builder response, so it invalidates precisely that page.
const pbStore = new PgPageStore();
const themeStore = new PgThemeStore();
const pbRegistry = defaultRegistry();
const pbPurge: PurgeLike = { invalidateByTags: (tags) => purgeEdgeTags(tags) };
const pageBuilder = new PageBuilder(pbStore, pbRegistry, pbPurge);

// Commerce webhook: map a gokwik change event → the surrogate tags the origin stamps on rendered
// pages (prod:<id> for products, col:<handle> for collections), so a product/price/collection edit
// purges exactly the cached storefront pages that showed that data.
function tagsForCommerceEvent(type: string, data: Record<string, unknown>): string[] {
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  switch (type) {
    case 'product.updated':
    case 'product.created':
    case 'product.deleted':
      return data.productId != null ? [`prod:${data.productId}`] : [];
    case 'products.bulk_updated':
    case 'inventory.updated':
    case 'pricing.updated':
      return ids(data.productIds).map((id) => `prod:${id}`);
    case 'collection.updated':
    case 'collection.created':
    case 'collection.deleted':
      return data.handle ? [`col:${data.handle}`] : [];
    default:
      return [];
  }
}

// HMAC-SHA256 over the RAW body (re-serializing would change the bytes the sender signed).
function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string) {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Section bindings that are backed by the commerce data layer — their presence tells the editor to
// show a data-source picker (collection/product) instead of just field inputs.
const DATA_BINDINGS = new Set(['grid', 'product', 'collection', 'price', 'stock']);

// The section catalog the editor renders forms from. Serializable metadata only (type + kind +
// typed settings + accepted child block types + which data binding, if any) — never the templates.
function sectionCatalog() {
  return pbRegistry.list().map((r) => ({
    type: r.type,
    // a type is a top-level section unless it's explicitly a child block
    kind: r.kind === 'block' ? 'block' : 'section',
    settings: r.settings ?? [],
    blocks: r.blocks ?? [],
    // the section's commerce data binding (e.g. productGrid→'grid', product→'product'), or null
    dataBinding: (r.bindings ?? []).map((b) => b.name).find((n) => DATA_BINDINGS.has(n)) ?? null,
  }));
}

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
  verify: Verifier = composeVerifiers(agentVerifier, insecureDevClerkVerifier, clerkVerifier),
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

  // /webhooks/commerce is public (gokwik calls it) — verified by HMAC signature, not Clerk.
  app.use(
    '*',
    authMiddleware(verify, ['/health', '/ready', '/', '/openapi.json', '/webhooks/commerce'])
  );
  // Reject cross-site cookie-authenticated mutations (I-1). After auth so a bad session 401s
  // first; before mutations run.
  // The commerce webhook is server-to-server (no cookie, no Origin) and HMAC-authenticated, so the
  // cookie-CSRF guard doesn't apply — exempt it or it 403s on the missing Origin.
  const csrf = csrfGuard(origins);
  app.use('*', (c, next) => (c.req.path === '/webhooks/commerce' ? next() : csrf(c, next)));
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
    if (e instanceof ConflictError || e instanceof IdempotencyInProgressError) {
      return c.json({ error: e.message }, 409);
    }
    // Log the real error server-side (method + path + stack) so prod 500s are diagnosable in the
    // container logs. The client still gets only the generic message in production.
    let pathname = c.req.path;
    try {
      pathname = new URL(c.req.url).pathname;
    } catch {
      /* keep c.req.path */
    }
    console.error(`[admin-api] 500 ${c.req.method} ${pathname}:`, e);
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
    // isLocal (RATIO_LOCAL) lets the SPA show dev-only affordances — e.g. a local storefront link
    // via the edge's ?store=<id> override — driven by the one run-environment flag, not a guess.
    return c.json({ userId, isPlatformAdmin: isPlatformAdmin(userId), isLocal: config.local });
  });

  // Commerce change webhook (gokwik → cache invalidation). Public + HMAC-verified. Maps the event
  // to the surrogate tags the origin stamped (prod:<id> / col:<handle>) and purges them, so a
  // product/price/collection change invalidates exactly the cached storefront pages that showed it.
  app.post('/webhooks/commerce', async (c) => {
    const raw = await c.req.text();
    const secret = process.env.WEBHOOK_SECRET;
    if (secret && !verifyWebhookSignature(raw, c.req.header('x-webhook-signature'), secret)) {
      return c.json({ error: 'invalid signature' }, 401);
    }
    let body: { type?: string; data?: Record<string, unknown> };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (!body.type) return c.json({ error: 'type is required' }, 400);
    const tags = tagsForCommerceEvent(body.type, body.data ?? {});
    await purgeEdgeTags(tags);
    return c.json({ ok: true, type: body.type, purged: tags });
  });

  // Store lifecycle — list / create / read / hard-delete (routes/stores.ts).
  app.route('/', storeRoutes({ pbStore, pageBuilder, platformSubdomainAllowed }));

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

  // Store settings — theme, theme versions (§13), commerce, collections (routes/store-settings.ts).
  app.route('/', storeSettingsRoutes({ pbStore, themeStore, purgeEdgeTags, purgeStoreUrls }));

  // Page builder — draft/publish (routes/page-builder.ts).
  app.route('/', pageBuilderRoutes({ pbStore, pageBuilder, purgeStoreUrls, sectionCatalog }));

  // Custom domains — Cloudflare-for-SaaS custom hostnames (routes/domains.ts).
  app.route('/', domainsRoutes({ pbStore }));

  return app;
}

export const app = createApp();
