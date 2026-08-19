import type { Hono } from 'hono';
import { onboardStore, deleteStore, listDomains } from '@ratio/data-provisioning';
import { forTenant } from '@ratio/data-repo';
import { buildCustomClient, commerceUrlsFromEnv, baseThemeDef } from '@ratio/builder-core';
import { config } from '../config';
import {
  isPlatformAdmin,
  listStoresForUser,
  listAllStores,
  requireMembership,
  requireRole,
  denyNarrowedScope,
  mintAgentToken,
} from '../middleware/auth';
import { listPlatformUsers } from '../services/platform-users';
import { recentAudit } from '../middleware/audit';
import {
  cfConfig,
  kvConfig,
  deleteCustomHostname,
  storeCacheUrls,
  unpublishTenantMapping,
  purgeUrls,
} from '../services/domains';
import type { RouteDeps, Vars } from './deps';

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

export function registerStoresRoutes(app: Hono<Vars>, deps: RouteDeps) {
  const { publishStoreThemeOnOnboard, pbStore } = deps;

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
    const { id, name, host, color, merchantId, baseThemeId } = (await c.req
      .json()
      .catch(() => ({}))) as {
      id?: string;
      name?: string;
      host?: string;
      color?: string;
      merchantId?: string;
      baseThemeId?: string;
    };
    if (!name || !host) {
      return c.json({ error: 'name and host are required' }, 400);
    }
    // The "start from" base the store adopts (optional; defaults to the platform Default). Reject an
    // unknown id up front so onboarding fails loud rather than silently falling back to the default.
    if (baseThemeId !== undefined && !baseThemeDef(baseThemeId)) {
      return c.json({ error: 'unknown base theme' }, 400);
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
    await publishStoreThemeOnOnboard(tenantId, baseThemeId).catch((e) => {
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
}
