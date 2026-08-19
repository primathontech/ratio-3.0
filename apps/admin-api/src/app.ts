import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { listDomains, ConflictError } from '@ratio/data-provisioning';
import { pool } from '@ratio/data-db';
import { resolveEdgeSecret } from '@ratio/edge-core';
import { config } from './config';
import { PageBuilder, type PurgeLike } from '@ratio/builder-core';
import { PgPageStore } from '@ratio/builder-core';
import {
  ThemeStore as BundleThemeStore,
  renderThemePage,
  renderThemeLayout,
  StubResolver,
} from '@ratio/builder-core';
import type { ThemeFiles } from '@ratio/builder-core';
import { resolveThemeTokens, tokenCss } from '@ratio/builder-core';
import type { ThemeTokens } from '@ratio/builder-core';
import { fetchMainMenu, fetchFooter, renderChrome } from '@ratio/builder-core';
import { renderUntrusted } from '@ratio/builder-render/isolate';
import { S3ObjectStore } from '@ratio/data-objects';
import { ensureDefaultBaseTheme, adoptAndPublishDefaultTheme } from '@ratio/builder-core';
import { commerceResolverFromEnv } from '@ratio/builder-core';
import type { TenantCommerce } from '@ratio/builder-core';
import {
  defaultRegistry,
  renderSection,
  islandPlaceholder,
  setUntrustedRenderer,
} from '@ratio/builder-registry';
import { cfConfig, purgeUrls, storeCacheUrls } from './services/domains';
import {
  authMiddleware,
  csrfGuard,
  clerkVerifier,
  insecureDevClerkVerifier,
  agentVerifier,
  composeVerifiers,
  type Verifier,
} from './middleware/auth';
import { auditMiddleware } from './middleware/audit';
import { createPgRateLimiter } from '@ratio/data-db';
import { createPgIdempotencyStore, IdempotencyInProgressError } from './middleware/idempotency';
import { createReadiness } from './middleware/readiness';
import type { RouteDeps, Vars } from './routes/deps';
import { registerSystemRoutes } from './routes/system';
import { registerStoresRoutes, platformSubdomainAllowed } from './routes/stores';
import { registerCommerceRoutes } from './routes/commerce';
import { registerAssistantRoutes } from './routes/assistant';
import { registerPageBuilderRoutes } from './routes/page-builder';
import { registerDomainRoutes } from './routes/domains';
import { registerBundleThemeRoutes } from './routes/themes/bundle';
import { registerThemeAssetsRoutes, isAssetUploadPath } from './routes/themes/assets';
import { ASSET_UPLOAD_BODY_LIMIT } from './constants';
import { registerMultiThemeRoutes } from './routes/themes/multi';
import { registerBaseThemeRoutes } from './routes/themes/base';
import { registerBaseThemeEditRoutes } from './routes/themes/base-edit';

export { platformSubdomainAllowed };

// Ratio CONTROL PLANE (ADR-014): the authenticated API the admin portal + AI agent
// both drive. Data plane (edge + origin) is separate and public; this is the write path.
// Auth is ADR-010: Clerk verifies identity, our memberships table authorizes per store.
// createApp takes the verifier so tests can inject identity without calling Clerk. The
// default accepts both human Clerk sessions and ADR-007 agent tokens on the same surface.

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
  // Mirror what the origin serves (apps/origin/src/index.ts): the theme's layout/theme.liquid owns the
  // whole document — render it with the chrome + sections + brand tokens. Preview is LENIENT (unlike the
  // live origin, which fails loud on a non-full-document theme): a merchant mid-edit may have an
  // incomplete layout, and renderThemeLayout renders whatever the draft carries so they can see their
  // work — the publish invariant is what blocks going live with a broken layout.
  const html = await renderThemeLayout(files, (l, d) => renderUntrusted(l, d), {
    content_for_layout: sections,
    header,
    footer,
    token_css: tokenCss(themeTokens),
    site_name: siteName,
  });
  return { html, tags, sampleData };
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
  // Cap request bodies so a member can't PUT a multi-MB pageConfig (storage/render abuse) or exhaust
  // memory (L11). 1 MB is generous for a page document. The binary-asset upload routes are the ONE
  // exception — they carry a file up to MAX_ASSET_BYTES plus multipart overhead — so they get a higher
  // limit here; the upload handler still enforces the exact per-file cap. Without this, the global 1 MB
  // limit would 413 every asset over 1 MB before the route is even reached.
  const smallBody = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  });
  const assetBody = bodyLimit({
    maxSize: ASSET_UPLOAD_BODY_LIMIT,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  });
  app.use('*', (c, next) => (isAssetUploadPath(c.req.path) ? assetBody : smallBody)(c, next));

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

  const bundle503 = (c: Context<Vars>) => c.json({ error: 'bundle store not configured' }, 503);

  const deps: RouteDeps = {
    themes,
    mainThemeId,
    ensureStoreTheme,
    publishStoreThemeOnOnboard,
    assertThemeInStore,
    identityCompile,
    bundle503,
    purgeEdgeTags,
    purgeStoreUrls,
    renderThemePreview,
    pbStore,
    pageBuilder,
    sectionCatalog,
    viaSelf,
    idem,
    readiness,
  };

  registerSystemRoutes(app, deps);
  registerStoresRoutes(app, deps);
  registerCommerceRoutes(app, deps);
  registerAssistantRoutes(app, deps);
  registerPageBuilderRoutes(app, deps);
  registerDomainRoutes(app, deps);
  registerBundleThemeRoutes(app, deps);
  registerThemeAssetsRoutes(app, deps);
  registerMultiThemeRoutes(app, deps);
  registerBaseThemeRoutes(app, deps);
  registerBaseThemeEditRoutes(app, deps);

  return app;
}

export const app = createApp();
