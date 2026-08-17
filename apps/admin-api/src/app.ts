import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
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
import { interpretCollectionsEnvelope } from './commerce-verify';
import { PageBuilder, type PurgeLike } from '@ratio/builder-core';
import type { PageDoc } from '@ratio/builder-core';
import { PgPageStore } from '@ratio/builder-core';
import {
  ThemeStore as BundleThemeStore,
  renderThemePage,
  renderThemeLayout,
  layoutOwnsDocument,
  StubResolver,
  DraftConflict,
} from '@ratio/builder-core';
import type { ThemeFiles } from '@ratio/builder-core';
import { storefrontHead, resolveThemeTokens, tokenCss } from '@ratio/builder-core';
import type { ThemeTokens } from '@ratio/builder-core';
import { fetchMainMenu, fetchFooter, renderChrome } from '@ratio/builder-core';
import { renderUntrusted } from '@ratio/builder-render/isolate';
import { S3ObjectStore } from '@ratio/data-objects';
import { ensureDefaultBaseTheme, adoptAndPublishDefaultTheme } from '@ratio/builder-core';
import {
  buildCustomClient,
  commerceUrlsFromEnv,
  commerceResolverFromEnv,
} from '@ratio/builder-core';
import type { TenantCommerce } from '@ratio/builder-core';
import { tenantTag } from '@ratio/builder-core';
import {
  defaultRegistry,
  renderSection,
  islandPlaceholder,
  setUntrustedRenderer,
} from '@ratio/builder-registry';
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
import { listPlatformUsers } from './platform-users';
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
  // cfConfig() fails closed in prod (throws) when a CF token is present but CF_SAAS_ZONE isn't. This
  // purge is best-effort, so a missing/partial CF config must degrade to "didn't purge" (null), never
  // 500 the caller (commerce save, theme save, page publish) — same fail-open intent as the `!cfg` case.
  let cfg;
  try {
    cfg = cfConfig();
  } catch {
    return null;
  }
  if (!cfg) return null;
  const urls = storeCacheUrls(await listDomains(id), paths);
  if (urls.length === 0) return null;
  return purgeUrls(cfg, urls).catch(() => false);
}

// Page-builder authoring (draft -> publish, D4): publish purges by the EXACT surrogate tag the
// origin stamps on a page-builder response, so it invalidates precisely that page.
const pbStore = new PgPageStore();

// Bundle-theme authoring (OFCE-601): the S3 ThemeStore (base ⊕ overrides) — the single theme system.
// Gated on BUNDLE_S3_BUCKET — null disables the theme endpoints so admin-api still boots without an
// object store configured. One working theme per store by default (id below); multi-theme adds more.
const bundleThemes = config.bundleStore
  ? new BundleThemeStore(new S3ObjectStore(config.bundleStore))
  : null;
const mainThemeId = (tenantId: string) => `${tenantId}-main`;

// Tenant isolation for the multi-theme routes: a theme id is a global, guessable string, so every
// theme-scoped route must prove the theme actually belongs to the store in the path — otherwise a
// member of store A could edit/activate/delete store B's theme by passing its id. Throws a
// 404-mapped error (onError) so a cross-store id is indistinguishable from a missing one.
class ThemeNotInStore extends Error {
  constructor(themeId: string, storeId: string) {
    super(`theme '${themeId}' not found in store '${storeId}'`);
    this.name = 'ThemeNotInStore';
  }
}
async function assertThemeInStore(themeId: string, storeId: string): Promise<void> {
  const { rowCount } = await pool.query('SELECT 1 FROM theme WHERE id = $1 AND tenant_id = $2', [
    themeId,
    storeId,
  ]);
  if (!rowCount) throw new ThemeNotInStore(themeId, storeId);
}
// No real theme compiler yet (every caller uses identity); the seam stays injected for a later slice.
const identityCompile = (s: ThemeFiles) => s;
const pbRegistry = defaultRegistry();
const pbPurge: PurgeLike = { invalidateByTags: (tags) => purgeEdgeTags(tags) };
const pageBuilder = new PageBuilder(pbStore, pbRegistry, pbPurge);

// Theme code editor live preview (OFCE-601): render a draft bundle theme to HTML the SAME way the
// origin does — merchant Liquid via the worker-thread isolate, first-party sections via the registry.
// Data binding follows the SAME real-vs-stub rule as the origin: when the store has a connected
// commerce backend (a merchantId) AND the platform service URLs are configured, resolve against the
// REAL backend so the merchant previews their own products; otherwise fall back to StubResolver
// sample data (local dev / tests / not-yet-connected), never throwing. Reused by POST
// /theme/bundle/preview; identical render shape to apps/origin/src/index.ts.
setUntrustedRenderer(renderUntrusted);
function previewResolver(commerce: TenantCommerce | null | undefined) {
  // Reuse the shared env→resolver helper (urls-configured check + client build) rather than
  // re-deriving it; null when the platform URLs aren't configured (local/tests) → sample data.
  const resolver = commerce?.merchantId ? commerceResolverFromEnv(process.env) : null;
  if (resolver && commerce?.merchantId) {
    return {
      resolver,
      commerce: { merchantId: commerce.merchantId, storeId: commerce.storeId } as TenantCommerce,
      sampleData: false,
    };
  }
  return { resolver: new StubResolver(), commerce: undefined, sampleData: true };
}
async function renderThemePreview(
  files: ThemeFiles,
  page: string,
  tenantId: string,
  commerce?: TenantCommerce | null,
  theme?: unknown,
  siteName = 'Store'
) {
  const { resolver, commerce: ctxCommerce, sampleData } = previewResolver(commerce);
  const navUrl = process.env.COMMERCE_NAV_API_URL ?? '';
  const merchantId = commerce?.merchantId ?? '';
  const [{ html: sections, tags }, menu, footerData] = await Promise.all([
    renderThemePage(
      files, // the composed draft (base ⊕ overrides) — no compile needed while compile is identity
      page,
      {
        theme: (liquid, data) => renderUntrusted(liquid, data),
        platform: (type, data) => {
          const rec = pbRegistry.get(type);
          if (!rec) throw new Error(`unknown platform section '${type}'`);
          if (rec.island)
            return Promise.resolve(islandPlaceholder(rec.island.name, { instance: type }));
          return renderSection(rec, data);
        },
      },
      // Body only — the layout is applied below (or the TS shell wraps it), matching the origin so the
      // preview is a faithful whole-page view.
      { resolver, ctx: { tenantId, routeParams: {}, commerce: ctxCommerce }, applyLayout: false }
    ),
    fetchMainMenu(merchantId, navUrl),
    fetchFooter(merchantId, navUrl),
  ]);
  const themeTokens = resolveThemeTokens(files, (theme ?? {}) as ThemeTokens);
  const { header, footer } = await renderChrome(files, (l, d) => renderUntrusted(l, d), {
    menu,
    footer: footerData,
    siteName,
  });
  // Mirror EXACTLY what the origin serves (apps/origin/src/index.ts): full theme ownership (OFCE-630)
  // when the flag is on AND the draft carries a full-document layout → render that layout (the theme
  // owns head + chrome + sections); otherwise the legacy TS shell wraps the body (doctype + <head> with
  // the design-system CSS + per-theme brand tokens + the theme's own assets/theme.css). Either way the
  // header/footer come from the theme's editable sections, so the preview shows edits as they will live.
  const themeOwnsDocument =
    process.env.THEME_OWNS_DOCUMENT === '1' && layoutOwnsDocument(files['layout/theme.liquid']);
  const html = themeOwnsDocument
    ? await renderThemeLayout(files, (l, d) => renderUntrusted(l, d), {
        content_for_layout: sections,
        header,
        footer,
        token_css: tokenCss(themeTokens),
        site_name: siteName,
      })
    : `<!doctype html><html lang="en"><head><meta charset="utf-8">${storefrontHead(themeTokens, files['assets/theme.css'] ?? '')}</head><body>${header}${sections}${footer}</body></html>`;
  return { html, tags, sampleData };
}

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
  bundleThemes?: BundleThemeStore | null; // inject a fake-ObjectStore-backed store in tests
}

export function createApp(
  verify: Verifier = composeVerifiers(agentVerifier, insecureDevClerkVerifier, clerkVerifier),
  opts: AppOptions = {}
) {
  const app = new Hono<Vars>();
  // Bundle-theme store: an explicitly injected value wins (including null, to force-disable in tests);
  // only an absent option falls back to the module-scoped one (null when S3 is unconfigured).
  const themes = opts.bundleThemes !== undefined ? opts.bundleThemes : bundleThemes;

  // Create a store's working bundle theme adopting the shared Default base (base ⊕ overrides): the
  // base provides the default files via composition, so a new store keeps only its own overrides —
  // no per-store copy of the default theme. Idempotent (ensureTheme is create-only, ensureDefault-
  // BaseTheme content-addressed); a no-op without a bundle store configured.
  async function ensureStoreTheme(tenantId: string): Promise<void> {
    if (!themes) return;
    // Hot path: once the store's theme row exists, this is a guaranteed no-op — ensureTheme is
    // create-only, so it can never change an existing row's base. Skip before touching the global
    // base-provisioning advisory lock, so editor autosaves across all tenants don't serialize through
    // one mutex. Checking existence (not base_theme_id) also lets a legacy baseless root theme
    // converge to the fast path instead of re-provisioning forever.
    const { rows } = await pool.query('SELECT 1 FROM theme WHERE id = $1', [mainThemeId(tenantId)]);
    if (rows[0]) return;
    const base = await ensureDefaultBaseTheme(themes, { compile: identityCompile });
    await themes.ensureTheme(tenantId, mainThemeId(tenantId), 'Theme', base);
  }

  // Onboarding variant: create the store's theme AND publish + activate it, so live_theme_id is set
  // from day one and the store renders through the bundle theme immediately (bundle = the single
  // renderer; the page-builder is only an emergency degrade-only fallback). OFCE-616 / ADR-013 §14.6.
  // Kept separate from ensureStoreTheme so the editor's create-only "ensure" guard never publishes as
  // a side effect. A no-op without a bundle store; best-effort at the call site.
  //
  // Guard on live_theme_id, NOT theme-row existence: if a prior attempt created the theme row but
  // failed before publish (or the editor's ensureStoreTheme created it), the row exists yet the store
  // is still on the page-builder — re-running must finish the job, not no-op forever. Once live, it's
  // a no-op (adopt/publish is only for a store with no live theme).
  async function publishStoreThemeOnOnboard(tenantId: string): Promise<void> {
    if (!themes) return;
    const { rows } = await pool.query<{ live_theme_id: string | null }>(
      'SELECT live_theme_id FROM tenants WHERE id = $1',
      [tenantId]
    );
    if (rows[0]?.live_theme_id) return;
    await adoptAndPublishDefaultTheme(themes, tenantId, mainThemeId(tenantId), {
      compile: identityCompile,
    });
  }

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
    if (e instanceof ThemeNotInStore) {
      return c.json({ error: 'not found' }, 404);
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

  // The stores the signed-in user may manage (drives the admin portal's home screen).
  // Platform admins see every store; everyone else sees only their memberships.
  app.get('/stores', async (c) => {
    const userId = c.get('userId');
    const stores = isPlatformAdmin(userId)
      ? await listAllStores()
      : await listStoresForUser(userId);
    return c.json({ stores });
  });

  // Every registered user + their stores (platform-admin console). The one cross-tenant read of
  // users, so it's platform-admin only — a normal member has no business enumerating the platform.
  // denyNarrowedScope: even a platform admin's scope-narrowed agent token must not pull the full
  // cross-tenant list; only full sessions (the SPA) reach this.
  app.get('/admin/users', denyNarrowedScope, async (c) => {
    if (!isPlatformAdmin(c.get('userId'))) return c.json({ error: 'forbidden' }, 403);
    return c.json({ users: await listPlatformUsers() });
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
      return c.json({ error: 'color must be a hex value like #2563eb' }, 400);
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
    // Adopt the shared Default base bundle theme AND publish + activate it, so the store is LIVE on
    // the bundle theme from the moment it exists — the same rich storefront the merchant sees in the
    // editor/wizard, never a separate page-builder scaffold (OFCE-616/618). Best-effort; a hiccup here
    // must not fail an otherwise-successful onboarding. No page-builder scaffold: the bundle theme is
    // the single renderer, so scaffolding page-builder pages only produced a confusing, never-shown
    // (or degrade-only) parallel storefront.
    await publishStoreThemeOnOnboard(tenantId).catch((e) => {
      console.error('publishStoreThemeOnOnboard failed for', tenantId, e);
    });
    // Free a reclaimed host's stale CF custom hostname so the new owner can connect it (OFCE-422).
    // Only reach for Cloudflare when a host was actually reclaimed: cfConfig() fails closed on a
    // missing SaaS zone in prod, so calling it on every onboard would 500 a fresh store that has
    // nothing to clean up (after the store row already committed → stranded, 409 on retry).
    if (hostReclaimedFrom) {
      const cfg = cfConfig();
      if (cfg) await deleteCustomHostname(cfg, lcHost).catch(() => {});
    }
    return c.json({ id: tenantId, url: `https://${lcHost}/` }, 201);
  });

  // Verify a commerce merchant id BEFORE a store exists (the onboarding wizard's step 1, OFCE-618).
  // Store-less: build a commerce client from the id alone + the env service URLs and ping the backend
  // (getCollections). We return a shape the UI can act on rather than a bare bool:
  //   - configured=false  → the commerce backend isn't wired in this environment (e.g. local dev) →
  //                          the wizard soft-passes ("can't verify here") instead of blocking.
  //   - verified=true + collectionCount → the id reached a real backend (count>0 is strong proof;
  //                          count=0 means reachable-but-empty, which the UI flags as "double-check").
  //   - verified=false    → the backend errored/rejected the id (unknown or inactive merchant).
  // No membership gate (there's no store yet); denyNarrowedScope keeps it to full onboarding sessions.
  app.post('/commerce/verify', denyNarrowedScope, async (c) => {
    const { merchantId } = (await c.req.json().catch(() => ({}))) as { merchantId?: string };
    const mid = String(merchantId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(mid)) {
      return c.json({ error: 'a valid merchantId is required' }, 400);
    }
    const urls = commerceUrlsFromEnv(process.env);
    const client = urls ? buildCustomClient({ merchantId: mid }, urls) : null;
    if (!client) {
      console.warn(
        '[commerce/verify] not configured — set COMMERCE_PRODUCT_API_URL, COMMERCE_CART_API_URL and COMMERCE_ORDER_API_URL (base URLs, no /api/v1 suffix)'
      );
      return c.json({ configured: false, verified: false });
    }
    try {
      // Fetch just ONE collection: verify only needs "does this merchant have any", and the backend
      // returns the true total in meta.pagination.total regardless of the page size — so first:1 is
      // the minimal call. The client resolves { success:false } rather than throwing on a bad id /
      // down backend, so the envelope decides verified — not the try/catch (a hard client throw only).
      const res = await client.getCollections({ first: 1 });
      const result = interpretCollectionsEnvelope(res);
      if (!result.verified) {
        // Surface WHY the backend didn't verify (unknown/inactive merchant, wrong base URL → 404, …)
        // instead of returning a silent verified:false.
        const env = res as { message?: string; error?: { message?: string } } | null;
        console.warn(
          `[commerce/verify] merchant ${mid} not verified: ${env?.error?.message ?? env?.message ?? 'backend returned no successful collections envelope'}`
        );
      }
      return c.json(result);
    } catch (e) {
      console.error(
        `[commerce/verify] request threw for merchant ${mid}:`,
        e instanceof Error ? e.message : e
      );
      return c.json({ configured: true, verified: false });
    }
  });

  // Read a store — caller must have a membership on it.
  app.get('/stores/:id', requireMembership, async (c) => {
    const tenant = await forTenant(c.req.param('id')).getTenant();
    if (!tenant) return c.json({ error: 'not found' }, 404);
    return c.json({ id: tenant.id, name: tenant.name, theme: tenant.theme });
  });

  // Provably-complete hard-delete (ADR-010 D-SEC4) — owner-only (M-4).
  app.delete('/stores/:id', requireRole('owner'), async (c) => {
    const id = c.req.param('id')!;
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

  // --- Bundle-theme authoring (OFCE-601 / OFCE-615, base ⊕ overrides). Distinct from the legacy Pg
  // theme routes above: merchant Liquid theme files stored as S3 bundles. A store may keep several
  // themes (OFCE-615); the legacy `/theme/bundle/*` paths edit the store's default theme (`${id}-main`),
  // the new `/themes/:themeId/*` paths edit a named theme. All gated on BUNDLE_S3_BUCKET — 503 when the
  // object store isn't wired.

  // The six editing handlers, parameterized by an explicit themeId so they mount at BOTH the legacy
  // one-theme-per-store paths (themeId = `${id}-main`) and the multi-theme `/themes/:themeId/*` paths.
  const bundle503 = (c: Context<Vars>) => c.json({ error: 'bundle store not configured' }, 503);

  // Save a theme's draft overrides (only the files it changed). `ensure` provisions the store's
  // default theme on first save (legacy path); the multi-theme path passes none — the theme already
  // exists (assertThemeInStore ran).
  async function draftPut(c: Context<Vars>, themeId: string, ensure?: () => Promise<void>) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as {
      files?: ThemeFiles;
      revision?: string;
    };
    // The editor always sends the revision it loaded; require it so a malformed/omitted body fails
    // loud (400) instead of a blind last-write-wins save.
    if (typeof body.revision !== 'string')
      return c.json({ error: 'revision is required to save a draft' }, 400);
    if (ensure) await ensure();
    // Store only the delta from the base (untouched files keep tracking base updates); reject the save
    // if another editor moved the draft first (409) instead of silently clobbering it.
    try {
      const { hash } = await themes.saveOverrides({ themeId, tenantId: id }, body.files ?? {}, {
        expectedRevision: body.revision,
      });
      c.set('auditTenant', id);
      return c.json({ ok: true, hash });
    } catch (e) {
      if (e instanceof DraftConflict)
        return c.json({ error: 'conflict', currentRevision: e.actual }, 409);
      throw e;
    }
  }

  // Read a theme's composed draft (base ⊕ overrides) + the revision token the editor round-trips.
  async function draftGet(c: Context<Vars>, themeId: string) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const [files, revision] = await Promise.all([
      themes.readComposed({ themeId, tenantId: id }),
      themes.draftRevision({ themeId, tenantId: id }),
    ]);
    return c.json({ files, revision });
  }

  // Ensure the theme opens populated instead of empty. A no-op (seeded:false) once it has content.
  async function scaffold(c: Context<Vars>, themeId: string, ensure: () => Promise<void>) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const existing = await themes.readComposed({ themeId, tenantId: id });
    if (Object.keys(existing).length > 0)
      return c.json({
        files: existing,
        seeded: false,
        revision: await themes.draftRevision({ themeId, tenantId: id }),
      });
    await ensure();
    const [files, revision] = await Promise.all([
      themes.readComposed({ themeId, tenantId: id }),
      themes.draftRevision({ themeId, tenantId: id }),
    ]);
    c.set('auditTenant', id);
    return c.json({ files, seeded: true, revision });
  }

  // Live preview: render a page to HTML. Renders the POSTed in-flight buffer when given, else the saved
  // draft. A Liquid/template error is the merchant's own code → { error } (200), not a 500.
  async function preview(c: Context<Vars>, themeId: string) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as { files?: ThemeFiles; page?: string };
    const files = body.files ?? (await themes.readComposed({ themeId, tenantId: id }));
    const page = body.page || 'index';
    try {
      const tenant = await forTenant(id).getTenant();
      const { html, sampleData } = await renderThemePreview(
        files,
        page,
        id,
        tenant?.commerce,
        tenant?.theme,
        tenant?.name
      );
      return c.json({ html, sampleData });
    } catch (e) {
      console.error('theme preview render failed:', e);
      return c.json({ error: e instanceof Error ? e.message : 'preview failed' });
    }
  }

  // Publish: freeze compile(base ⊕ overrides), cut an immutable version, flip the live pointer.
  async function publishBundle(c: Context<Vars>, themeId: string) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    // Publish does NOT create the theme — draft-save is the create point.
    let version: number;
    try {
      ({ version } = await themes.publish(
        { themeId, tenantId: id },
        { compile: identityCompile, by: c.get('userId') }
      ));
    } catch (e) {
      if (e instanceof Error && /unknown theme/.test(e.message))
        return c.json({ error: 'no draft to publish — save a draft first' }, 400);
      throw e; // infra faults (S3/DB) bubble to onError → 500 + logged, not a misleading 400
    }
    // publish() enqueued a durable tenant-tag purge in its txn; purgeEdgeTags hits the local edge-sim.
    await purgeEdgeTags([tenantTag(id)]);
    c.set('auditTenant', id);
    return c.json({ ok: true, version });
  }

  // Roll the live pointer back to an earlier published version of the store's live theme (the bundles
  // are all still in S3). Operates on the tenant's live pointer, so it takes no themeId.
  async function rollbackBundle(c: Context<Vars>) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number')
      return c.json({ error: 'version (number) is required' }, 400);
    try {
      await themes.rollback(id, body.version);
    } catch (e) {
      if (e instanceof Error && /unknown version|no published theme|unknown tenant/.test(e.message))
        return c.json({ error: e.message }, 404);
      throw e;
    }
    await purgeEdgeTags([tenantTag(id)]);
    c.set('auditTenant', id);
    return c.json({ ok: true, version: body.version });
  }

  // Reset a theme's draft to pure base — drop every override (the merchant's customizations) so the
  // editor is back to the default theme. A member edit (like draft-save), not owner-only. Returns the
  // now-composed files + the fresh revision so the editor swaps its buffer in place.
  async function resetBundle(c: Context<Vars>, themeId: string, ensure?: () => Promise<void>) {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    // Ensure the theme row exists first (legacy main-theme mount) so reset can't write an orphan draft
    // blob for a never-created theme; the multi-theme mount skips this (assertThemeInStore proved it).
    if (ensure) await ensure();
    await themes.resetDraft({ themeId, tenantId: id });
    const [files, revision] = await Promise.all([
      themes.readComposed({ themeId, tenantId: id }),
      themes.draftRevision({ themeId, tenantId: id }),
    ]);
    c.set('auditTenant', id);
    return c.json({ ok: true, files, revision });
  }

  // Legacy one-theme-per-store mounts (back-compat: the current editor + its tests). themeId = default.
  app.put('/stores/:id/theme/bundle/draft', requireMembership, (c) =>
    draftPut(c, mainThemeId(c.req.param('id')), () => ensureStoreTheme(c.req.param('id')))
  );
  app.get('/stores/:id/theme/bundle/draft', requireMembership, (c) =>
    draftGet(c, mainThemeId(c.req.param('id')))
  );
  app.post('/stores/:id/theme/bundle/scaffold', requireMembership, (c) =>
    scaffold(c, mainThemeId(c.req.param('id')), () => ensureStoreTheme(c.req.param('id')))
  );
  app.post('/stores/:id/theme/bundle/preview', requireMembership, (c) =>
    preview(c, mainThemeId(c.req.param('id')))
  );
  app.post('/stores/:id/theme/bundle/publish', requireRole('owner'), (c) =>
    publishBundle(c, mainThemeId(c.req.param('id')))
  );
  app.post('/stores/:id/theme/bundle/rollback', requireRole('owner'), (c) => rollbackBundle(c));
  app.post('/stores/:id/theme/bundle/reset', requireMembership, (c) =>
    resetBundle(c, mainThemeId(c.req.param('id')), () => ensureStoreTheme(c.req.param('id')))
  );

  // --- Multi-theme CRUD + selection (OFCE-615 Phase 1). A store may keep several themes; exactly one
  // is live. Every theme-scoped route calls assertThemeInStore after the auth guard, so a member of
  // store A can never touch store B's theme by passing its id (404, indistinguishable from missing).

  // List the store's themes (which is live, each theme's latest published version).
  app.get('/stores/:id/themes', requireMembership, async (c) => {
    if (!themes) return bundle503(c);
    return c.json({ themes: await themes.listThemes(c.req.param('id')) });
  });

  // Create a theme — a fresh one adopting the shared Default base, or a duplicate of an existing theme.
  app.post('/stores/:id/themes', requireMembership, async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; duplicateOf?: string };
    const themeId = `${id}-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const name = body.name ?? 'New theme';
    if (body.duplicateOf) {
      await assertThemeInStore(body.duplicateOf, id);
      await themes.createTheme(id, themeId, name, { duplicateOf: body.duplicateOf });
    } else {
      const base = await ensureDefaultBaseTheme(themes, { compile: identityCompile });
      await themes.createTheme(id, themeId, name, { base });
    }
    c.set('auditTenant', id);
    return c.json({ id: themeId });
  });

  // Rename a theme.
  app.patch('/stores/:id/themes/:themeId', requireMembership, async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const themeId = c.req.param('themeId');
    await assertThemeInStore(themeId, id);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    if (typeof body.name !== 'string' || !body.name.trim())
      return c.json({ error: 'name is required' }, 400);
    await themes.renameTheme(id, themeId, body.name);
    c.set('auditTenant', id);
    return c.json({ ok: true });
  });

  // Delete a theme (owner). Refuses the live theme (409).
  app.delete('/stores/:id/themes/:themeId', requireRole('owner'), async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const themeId = c.req.param('themeId');
    await assertThemeInStore(themeId, id);
    try {
      await themes.deleteTheme(id, themeId);
    } catch (e) {
      if (e instanceof Error && /cannot delete the live theme/.test(e.message))
        return c.json({ error: e.message }, 409);
      throw e;
    }
    c.set('auditTenant', id);
    return c.json({ ok: true });
  });

  // Activate a theme at a given (or its latest published) version — the general switch/rollback primitive.
  app.post('/stores/:id/themes/:themeId/activate', requireRole('owner'), async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const themeId = c.req.param('themeId');
    await assertThemeInStore(themeId, id);
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    let version: number;
    try {
      ({ version } = await themes.setLive(id, themeId, body.version));
    } catch (e) {
      if (e instanceof Error && /no published version/.test(e.message))
        return c.json({ error: e.message }, 400);
      if (e instanceof Error && /unknown version/.test(e.message))
        return c.json({ error: e.message }, 404);
      throw e;
    }
    await purgeEdgeTags([tenantTag(id)]);
    c.set('auditTenant', id);
    return c.json({ version });
  });

  // A theme's published version history + which one is live.
  app.get('/stores/:id/themes/:themeId/versions', requireMembership, async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const themeId = c.req.param('themeId');
    await assertThemeInStore(themeId, id);
    const versions = await themes.listVersions(id, themeId);
    const { rows } = await pool.query<{ live_theme_version: number }>(
      'SELECT live_theme_version FROM tenants WHERE id = $1 AND live_theme_id = $2',
      [id, themeId]
    );
    const liveVersion = rows[0]?.live_theme_version ?? null;
    return c.json({ versions, liveVersion });
  });

  // Theme-scoped editing mounts (multi-theme). assertThemeInStore enforces ownership on each.
  app.put('/stores/:id/themes/:themeId/draft', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return draftPut(c, c.req.param('themeId'));
  });
  app.get('/stores/:id/themes/:themeId/draft', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return draftGet(c, c.req.param('themeId'));
  });
  app.post('/stores/:id/themes/:themeId/scaffold', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return scaffold(c, c.req.param('themeId'), async () => {});
  });
  app.post('/stores/:id/themes/:themeId/preview', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return preview(c, c.req.param('themeId'));
  });
  app.post('/stores/:id/themes/:themeId/reset', requireMembership, async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return resetBundle(c, c.req.param('themeId'));
  });
  app.post('/stores/:id/themes/:themeId/publish', requireRole('owner'), async (c) => {
    await assertThemeInStore(c.req.param('themeId'), c.req.param('id'));
    return publishBundle(c, c.req.param('themeId'));
  });
  // Theme-scoped rollback = repoint the live pointer to (this theme, an earlier version). Unlike the
  // legacy /theme/bundle/rollback (which rolls whatever is live), this is themeId-aware: rolling a
  // theme back to vN makes THAT theme live at vN. Same primitive as activate.
  app.post('/stores/:id/themes/:themeId/rollback', requireRole('owner'), async (c) => {
    if (!themes) return bundle503(c);
    const id = c.req.param('id')!;
    const themeId = c.req.param('themeId');
    await assertThemeInStore(themeId, id);
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number') return c.json({ error: 'version required' }, 400);
    try {
      await themes.setLive(id, themeId, body.version);
    } catch (e) {
      if (e instanceof Error && /unknown version|no published version/.test(e.message))
        return c.json({ error: e.message }, 404);
      throw e;
    }
    await purgeEdgeTags([tenantTag(id)]);
    c.set('auditTenant', id);
    return c.json({ ok: true, version: body.version });
  });

  // Commerce backend connection: the GoKwik merchant id that powers products/collections/cart.
  app.get('/stores/:id/commerce', requireMembership, async (c) => {
    const tenant = await forTenant(c.req.param('id')).getTenant();
    if (!tenant) return c.json({ error: 'not found' }, 404);
    return c.json({ merchantId: tenant.commerce?.merchantId ?? '' });
  });

  // Connect/update (or disconnect with an empty id) the commerce backend. Owner-only. Purge the
  // store's pages — product/collection data is baked into the cached shells.
  app.put('/stores/:id/commerce', requireRole('owner'), async (c) => {
    const id = c.req.param('id')!;
    const body = (await c.req.json().catch(() => ({}))) as { merchantId?: string };
    const merchantId = String(body.merchantId ?? '').trim();
    await forTenant(id).setCommerce(merchantId ? { merchantId } : null);
    await purgeEdgeTags([tenantTag(id)]); // local dev edge-sim (by tag)
    const pages = await pbStore.listPages(id);
    const edgePurged = await purgeStoreUrls(
      id,
      pages.map((p) => p.path)
    );
    c.set('auditTenant', id);
    return c.json({ ok: true, merchantId, ...(edgePurged !== null && { edgePurged }) });
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
    const id = c.req.param('id')!;
    const path = c.req.query('path') || '/';
    const [draft, live, revision] = await Promise.all([
      pbStore.getDraft(id, path),
      pbStore.getLive(id, path),
      pbStore.revision(id, path),
    ]);
    return c.json({ path, draft, live, revision, hasDraft: draft !== null });
  });

  app.put('/stores/:id/page-builder', requireMembership, async (c) => {
    const id = c.req.param('id')!;
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
    const id = c.req.param('id')!;
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
    const id = c.req.param('id')!;
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
        try {
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
        } catch (e) {
          // One domain's status lookup / read-repair failing must NOT 500 the whole panel —
          // degrade that row to "pending" and log it (visible via onError-style server logs).
          console.error(`[admin-api] domain-status failed for ${host} (tenant ${id}):`, e);
          return { host, kind: 'custom', status: 'pending', sslStatus: 'unknown' };
        }
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
    const id = c.req.param('id')!;
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
