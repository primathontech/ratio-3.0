// Cloudflare-for-SaaS custom-hostname integration for the domain-connect flow (ADR-013).
// Mirrors the cf-saas / cf-hostname-status workflows: create a custom hostname on the SaaS
// zone (ratiodev.in), then the merchant CNAMEs their domain to the fallback + adds the DV
// TXT records. fetch is injected so the API layer is testable without calling Cloudflare.

import { getDomain } from 'tldts';

const CF_API = 'https://api.cloudflare.com/client/v4';

export interface CfConfig {
  token: string;
  zone: string; // SaaS zone (ratiodev.in)
  fallback: string; // CNAME target merchants point at (service.ratiodev.in)
}

// Null when the admin-api hasn't been given a Cloudflare token — endpoints degrade to a
// clear "custom domains not configured" instead of crashing.
export function cfConfig(): CfConfig | null {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return null;
  return {
    token,
    zone: process.env.CF_SAAS_ZONE || 'ratiodev.in',
    fallback: process.env.CF_SAAS_FALLBACK || 'service.ratiodev.in',
  };
}

export interface DnsRecord {
  type: string; // CNAME | ALIAS | TXT — accurate for apex vs subdomain
  name: string; // full record name (FQDN)
  host: string; // name relative to the zone — what DNS UIs want (@, www, _acme-challenge)
  value: string;
  ttl: string;
  purpose: string;
}
export interface DomainConnection {
  host: string;
  status: string; // pending | active | ...
  sslStatus: string; // pending_validation | active | ...
  cnameTarget: string;
  apex: boolean; // true if a root domain (can't take a CNAME at most registrars)
  records: DnsRecord[];
}

// Registrable zone (eTLD+1) via the Public Suffix List, so multi-part TLDs like .co.uk /
// .com.au resolve correctly. Used to show provider-style relative host names.
function zoneOf(host: string): string {
  return getDomain(host) || host;
}
function relName(fqdn: string, zone: string): string {
  if (fqdn === zone) return '@';
  if (fqdn.endsWith('.' + zone)) return fqdn.slice(0, -(zone.length + 1));
  return fqdn;
}

interface CfResult {
  success: boolean;
  errors?: { message: string }[];
  result?: Record<string, unknown>;
}

async function cf(
  cfg: CfConfig,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<CfResult> {
  const res = await fetchImpl(CF_API + path, {
    ...init,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  return (await res.json()) as CfResult;
}

const zoneIdCache = new Map<string, string>();
async function zoneId(cfg: CfConfig, fetchImpl: typeof fetch): Promise<string> {
  const cached = zoneIdCache.get(cfg.zone);
  if (cached) return cached;
  const r = await cf(
    cfg,
    `/zones?name=${encodeURIComponent(cfg.zone)}`,
    { method: 'GET' },
    fetchImpl
  );
  const id = (r.result as unknown as { id: string }[] | undefined)?.[0]?.id;
  if (!id) throw new Error(`Cloudflare zone not found: ${cfg.zone}`);
  zoneIdCache.set(cfg.zone, id);
  return id;
}

function toConnection(cfg: CfConfig, host: string, ch: Record<string, unknown>): DomainConnection {
  const ssl = (ch.ssl as Record<string, unknown>) || {};
  const zone = zoneOf(host);
  const apex = host === zone;
  const records: DnsRecord[] = [
    {
      // Root domains can't take a CNAME at most registrars → ALIAS/ANAME (or forward to www).
      type: apex ? 'ALIAS' : 'CNAME',
      name: host,
      host: relName(host, zone),
      value: cfg.fallback,
      ttl: 'Auto',
      purpose: apex
        ? 'Route the root domain (use ALIAS/ANAME, or forward the root to your www subdomain)'
        : 'Route traffic to Ratio',
    },
  ];
  const ov = ch.ownership_verification as { name?: string; value?: string } | undefined;
  if (ov?.name) {
    records.push({
      type: 'TXT',
      name: ov.name,
      host: relName(ov.name, zone),
      value: ov.value ?? '',
      ttl: 'Auto',
      purpose: 'Verify domain ownership',
    });
  }
  for (const v of (ssl.validation_records as { txt_name?: string; txt_value?: string }[]) || []) {
    if (v.txt_name) {
      records.push({
        type: 'TXT',
        name: v.txt_name,
        host: relName(v.txt_name, zone),
        value: v.txt_value ?? '',
        ttl: 'Auto',
        purpose: 'Issue SSL certificate',
      });
    }
  }
  return {
    host,
    status: (ch.status as string) || 'pending',
    sslStatus: (ssl.status as string) || 'pending_validation',
    cnameTarget: cfg.fallback,
    apex,
    records,
  };
}

export async function connectCustomHostname(
  cfg: CfConfig,
  host: string,
  fetchImpl: typeof fetch = fetch
): Promise<DomainConnection> {
  const zid = await zoneId(cfg, fetchImpl);
  const r = await cf(
    cfg,
    `/zones/${zid}/custom_hostnames`,
    {
      method: 'POST',
      body: JSON.stringify({ hostname: host, ssl: { method: 'txt', type: 'dv' } }),
    },
    fetchImpl
  );
  if (!r.success || !r.result) {
    throw new Error(
      r.errors?.map((e) => e.message).join('; ') || 'Cloudflare rejected the hostname'
    );
  }
  return toConnection(cfg, host, r.result);
}

// Delete the CF custom hostname for a host (audit R10/OFCE-422). Called on a cross-tenant
// reclaim so the new claimant can create their own custom hostname and run its DV — otherwise
// CF's one-object-per-hostname rule lets whoever connected first permanently block everyone
// else (a legit owner couldn't onboard their own domain). Best-effort; returns false if none.
export async function deleteCustomHostname(
  cfg: CfConfig,
  host: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const zid = await zoneId(cfg, fetchImpl);
  const list = await cf(
    cfg,
    `/zones/${zid}/custom_hostnames?hostname=${encodeURIComponent(host)}`,
    { method: 'GET' },
    fetchImpl
  );
  const id = (list.result as unknown as { id: string }[] | undefined)?.[0]?.id;
  if (!id) return false;
  const del = await cf(
    cfg,
    `/zones/${zid}/custom_hostnames/${id}`,
    { method: 'DELETE' },
    fetchImpl
  );
  return !!del.success;
}

// Purge specific storefront URLs from the Cloudflare edge cache. Purge-by-URL works on all
// plans (unlike Cache-Tags, which need Enterprise). Best-effort: callers ignore failures so
// a purge outage never fails the underlying write (OFCE-411).
// Cacheable storefront URLs for a store's real (non-localhost) domains × its route paths —
// the set to purge when the whole store changes (delete / suspend / domain removal). Root is
// always included even if there are no routes yet.
export function storeCacheUrls(hosts: string[], paths: string[]): string[] {
  const real = hosts.filter((h) => !h.endsWith('.localhost'));
  const ps = paths.length ? Array.from(new Set(['/', ...paths])) : ['/'];
  return real.flatMap((h) => ps.map((p) => `https://${h}${p}`));
}

export async function purgeUrls(
  cfg: CfConfig,
  urls: string[],
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (urls.length === 0) return true;
  const zid = await zoneId(cfg, fetchImpl);
  const r = await cf(
    cfg,
    `/zones/${zid}/purge_cache`,
    { method: 'POST', body: JSON.stringify({ files: urls }) },
    fetchImpl
  );
  return !!r.success;
}

export async function customHostnameStatus(
  cfg: CfConfig,
  host: string,
  fetchImpl: typeof fetch = fetch
): Promise<DomainConnection | null> {
  const zid = await zoneId(cfg, fetchImpl);
  const r = await cf(
    cfg,
    `/zones/${zid}/custom_hostnames?hostname=${encodeURIComponent(host)}`,
    { method: 'GET' },
    fetchImpl
  );
  const ch = (r.result as unknown as Record<string, unknown>[] | undefined)?.[0];
  return ch ? toConnection(cfg, host, ch) : null;
}
