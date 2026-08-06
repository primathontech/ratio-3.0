import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
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
} from '@ratio/data-provisioning';
import { forTenant } from '@ratio/data-repo';
import { pool } from '@ratio/data-db';
import { resolveEdgeSecret } from '@ratio/edge-core';
import { config } from './config';
import { PageBuilder, type PurgeLike } from '@ratio/builder-core';
import type { PageDoc } from '@ratio/builder-core';
import { PgPageStore } from '@ratio/builder-core';
import { scaffoldStorefront } from '@ratio/builder-core';
import { buildCustomClient, commerceUrlsFromEnv } from '@ratio/builder-core';
import { tenantTag } from '@ratio/builder-core';
import { FONTS, BASE_SIZE, RADIUS, CONTAINER, type ThemeTokens } from '@ratio/builder-core';
import { defaultRegistry } from '@ratio/builder-registry';
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
type Vars = { Variables: { userId: string; scope?: string[]; auditTenant?: string } };

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

// Validate a theme at the boundary: brand colour is free-form hex, every other knob must be a key
// of its fixed scale. Reject anything off-scale (don't silently drop) so the editor surfaces it.
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
function validateTheme(input: unknown): ThemeTokens {
  if (!input || typeof input !== 'object') throw new Error('theme must be an object');
  const t = input as Record<string, unknown>;
  const pick = (key: string, scale: Record<string, string>): string | undefined => {
    const v = t[key];
    if (v == null) return undefined;
    if (typeof v !== 'string' || !(v in scale)) throw new Error(`invalid ${key}`);
    return v;
  };
  if (t.color != null && (typeof t.color !== 'string' || !HEX.test(t.color)))
    throw new Error('color must be a hex value');
  return {
    color: typeof t.color === 'string' ? t.color : undefined,
    bodyFont: pick('bodyFont', FONTS),
    headingFont: pick('headingFont', FONTS),
    baseSize: pick('baseSize', BASE_SIZE),
    radius: pick('radius', RADIUS),
    container: pick('container', CONTAINER),
  };
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
    const { id, name, host, color, merchantId } = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      host?: string;
      color?: string;
      merchantId?: string;
    };
    if (!name || !host) {
      return c.json({ error: 'name and host are required' }, 400);
    }
    // The gokwik merchant id (data-layer). Optional at create; identifies the store's catalog.
    if (merchantId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(merchantId)) {
      return c.json({ error: 'merchantId must be 1–64 chars: letters, digits, _ or -' }, 400);
    }
    // The store id is GENERATED server-side (merchants never supply one). An explicit id is only
    // accepted from internal callers (CLI/scripts) — validate its slug shape when present, since it
    // flows into routing, cache-purge URLs, and agent-token scopes (where '*' is the wildcard).
    if (id !== undefined && !/^[a-z][a-z0-9_-]{1,62}$/.test(id)) {
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
    const { id: tenantId, hostReclaimedFrom } = await onboardStore({
      id,
      name,
      host: lcHost,
      color,
      ownerUserId: c.get('userId'),
      merchantId,
      local: config.local,
    });
    c.set('auditTenant', tenantId); // onboarding: the store id isn't in the path, so set it here
    // Scaffold the default home + product + collection pages so the store renders out of the box
    // (the page builder is the sole renderer, so these URLs 404 until the pages exist). Best-effort
    // — a scaffold hiccup must not fail an otherwise-successful onboarding; the merchant can re-add
    // pages in the editor.
    await scaffoldStorefront(pageBuilder, tenantId, { name }).catch(() => {});
    // Free a reclaimed host's stale CF custom hostname so the new owner can connect it (OFCE-422).
    const cfg = cfConfig();
    if (hostReclaimedFrom && cfg) await deleteCustomHostname(cfg, lcHost).catch(() => {});
    return c.json({ id: tenantId, url: `https://${lcHost}/` }, 201);
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
          (await pbStore.listPages(id))
            .filter((p) => p.published && !p.path.includes(':'))
            .map((p) => p.path)
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

  // The store's collections, for the editor's collection picker. Builds the tenant's commerce client
  // (env service URLs + the tenant's own merchantId) and returns the CANONICAL collections envelope-
  // navigated only — no shaping here (the SPA maps to {handle,title}). Empty when not connected.
  app.get('/stores/:id/collections', requireMembership, async (c) => {
    const urls = commerceUrlsFromEnv(process.env);
    if (!urls) return c.json({ collections: [] });
    const tenant = await forTenant(c.req.param('id')).getTenant();
    const client = buildCustomClient(tenant?.commerce, urls);
    if (!client) return c.json({ collections: [] });
    const res = await client.getCollections({ first: 100 });
    const data = res?.data;
    const collections = Array.isArray(data) ? data : (data?.collections ?? []);
    return c.json({ collections });
  });

  // The store's storefront theme (global style knobs) — read by the Theme Settings panel.
  app.get('/stores/:id/theme', requireMembership, async (c) => {
    const tenant = await forTenant(c.req.param('id')).getTenant();
    if (!tenant) return c.json({ error: 'not found' }, 404);
    return c.json({ theme: tenant.theme ?? {} });
  });

  // Save the theme. Validated against the fixed scales, persisted, then the tenant's pages are
  // purged — the theme is baked into every cached shell, so a change invalidates all of them.
  app.put('/stores/:id/theme', requireMembership, async (c) => {
    const id = c.req.param('id');
    let theme: ThemeTokens;
    try {
      theme = validateTheme(await c.req.json().catch(() => ({})));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'invalid theme' }, 400);
    }
    await forTenant(id).setTheme(theme);
    await purgeEdgeTags([tenantTag(id)]); // local dev edge-sim (by tag)
    // Prod: theme is baked into every page's shell, so purge all the store's page URLs.
    const pages = await pbStore.listPages(id);
    const edgePurged = await purgeStoreUrls(
      id,
      pages.map((p) => p.path)
    );
    c.set('auditTenant', id);
    return c.json({ ok: true, theme, ...(edgePurged !== null && { edgePurged }) });
  });

  // --- Page builder (ADR-013 / D4 draft->publish). The editor's write surface: save a draft
  // (validated + version-pinned, live page untouched), then publish to promote draft->live and
  // purge. The origin serves the published PageDoc (the sole renderer). ---

  // Global section catalog (any authenticated user) — the editor renders inputs from it.
  app.get('/page-builder/catalog', (c) => c.json({ sections: sectionCatalog() }));

  // Every page-builder page for a store (path + publish state) — the editor's page switcher.
  app.get('/stores/:id/page-builder/pages', requireMembership, async (c) => {
    return c.json({ pages: await pbStore.listPages(c.req.param('id')) });
  });

  app.get('/stores/:id/page-builder', requireMembership, async (c) => {
    const id = c.req.param('id');
    const path = c.req.query('path') || '/';
    const [draft, live, revision] = await Promise.all([
      pbStore.getDraft(id, path),
      pbStore.getLive(id, path),
      pbStore.revision(id, path),
    ]);
    return c.json({ path, draft, live, revision, hasDraft: draft !== null });
  });

  app.put('/stores/:id/page-builder', requireMembership, async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { doc?: unknown };
    if (typeof body.doc !== 'object' || body.doc === null) {
      return c.json({ error: 'doc (a PageDoc) is required' }, 400);
    }
    try {
      // validatePageDoc (inside saveDraft) rejects unknown section/block types + bad settings.
      const draft = await pageBuilder.saveDraft(id, body.doc as PageDoc);
      c.set('auditTenant', id);
      return c.json({ ok: true, draft });
    } catch (e) {
      return c.json({ error: 'invalid page doc', detail: (e as Error).message }, 422);
    }
  });

  app.post('/stores/:id/page-builder/publish', requireMembership, async (c) => {
    const id = c.req.param('id');
    const path = ((await c.req.json().catch(() => ({}))) as { path?: string }).path || '/';
    const res = await pageBuilder.publish(id, path);
    if (!res) return c.json({ error: 'no draft to publish' }, 404);
    // pageBuilder.publish already purged the local edge by tag; also purge the prod CF edge by URL.
    const edgePurged = await purgeStoreUrls(id, [path]);
    c.set('auditTenant', id);
    return c.json({ ok: true, revision: res.revision, ...(edgePurged !== null && { edgePurged }) });
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
      const paths = (await pbStore.listPages(id))
        .filter((p) => p.published && !p.path.includes(':'))
        .map((p) => p.path);
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
