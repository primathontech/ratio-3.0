// Store lifecycle routes: list / create / read / hard-delete. Split out of app.ts per Hono's
// app.route() best practice; handlers stay inline.
import { Hono } from 'hono';
import type { PgPageStore, PageBuilder } from '@ratio/builder-core';
import { scaffoldStorefront } from '@ratio/builder-core';
import { onboardStore, deleteStore, listDomains } from '@ratio/data-provisioning';
import { forTenant } from '@ratio/data-repo';
import {
  cfConfig,
  deleteCustomHostname,
  kvConfig,
  storeCacheUrls,
  unpublishTenantMapping,
  purgeUrls,
} from '../domains';
import {
  requireMembership,
  requireRole,
  denyNarrowedScope,
  isPlatformAdmin,
  listStoresForUser,
  listAllStores,
} from '../auth';
import { config } from '../config';
import type { Vars } from '../types';

export interface StoresDeps {
  pbStore: PgPageStore;
  pageBuilder: PageBuilder;
  platformSubdomainAllowed: (host: string, isAdmin: boolean) => boolean;
}

export function storeRoutes(deps: StoresDeps): Hono<Vars> {
  const { pbStore, pageBuilder, platformSubdomainAllowed } = deps;
  const r = new Hono<Vars>();

  // The stores the signed-in user may manage (drives the admin portal's home screen).
  // Platform admins see every store; everyone else sees only their memberships.
  r.get('/stores', async (c) => {
    const userId = c.get('userId');
    const stores = isPlatformAdmin(userId)
      ? await listAllStores()
      : await listStoresForUser(userId);
    return c.json({ stores });
  });

  // Create a store. The authenticated caller becomes its owner — the membership is
  // written in the same transaction as the tenant, so a store always has an owner.
  r.post('/stores', denyNarrowedScope, async (c) => {
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
  r.get('/stores/:id', requireMembership, async (c) => {
    const tenant = await forTenant(c.req.param('id')).getTenant();
    if (!tenant) return c.json({ error: 'not found' }, 404);
    return c.json({ id: tenant.id, name: tenant.name, theme: tenant.theme });
  });

  // Provably-complete hard-delete (ADR-010 D-SEC4) — owner-only (M-4).
  r.delete('/stores/:id', requireRole('owner'), async (c) => {
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

  return r;
}
