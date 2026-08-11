// Custom-domain routes (OFCE-398 / ADR-013). Cloudflare-for-SaaS custom hostnames; platform
// *.ratiodev.in subdomains are already live via wildcard. Split out of app.ts per Hono's app.route().
import { Hono } from 'hono';
import type { PgPageStore } from '@ratio/builder-core';
import { pool } from '@ratio/data-db';
import {
  listDomains,
  addDomain,
  removeDomain,
  markDomainVerified,
  markDomainConnected,
} from '@ratio/data-provisioning';
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
} from '../domains';
import { requireMembership, requireRole } from '../auth';
import type { Vars } from '../types';

export interface DomainsDeps {
  pbStore: PgPageStore;
}

const isPlatformHost = (h: string) => h.endsWith('.ratiodev.in') || h.endsWith('.localhost');

export function domainsRoutes(deps: DomainsDeps): Hono<Vars> {
  const { pbStore } = deps;
  const r = new Hono<Vars>();

  r.get('/stores/:id/domains', requireMembership, async (c) => {
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
  r.post('/stores/:id/domains', requireRole('owner'), async (c) => {
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

  r.delete('/stores/:id/domains', requireRole('owner'), async (c) => {
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
  r.get('/stores/:id/domain', requireMembership, async (c) => {
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

  return r;
}
