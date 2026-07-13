// Cloudflare-for-SaaS custom-hostname integration for the domain-connect flow (ADR-013).
// Mirrors the cf-saas / cf-hostname-status workflows: create a custom hostname on the SaaS
// zone (ratiodev.in), then the merchant CNAMEs their domain to the fallback + adds the DV
// TXT records. fetch is injected so the API layer is testable without calling Cloudflare.

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
  type: string;
  name: string;
  value: string;
  purpose: string;
}
export interface DomainConnection {
  host: string;
  status: string; // pending | active | ...
  sslStatus: string; // pending_validation | active | ...
  cnameTarget: string;
  records: DnsRecord[];
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
  const records: DnsRecord[] = [
    { type: 'CNAME', name: host, value: cfg.fallback, purpose: 'Route traffic to Ratio' },
  ];
  const ov = ch.ownership_verification as { name?: string; value?: string } | undefined;
  if (ov?.name) {
    records.push({
      type: 'TXT',
      name: ov.name,
      value: ov.value ?? '',
      purpose: 'Verify domain ownership',
    });
  }
  for (const v of (ssl.validation_records as { txt_name?: string; txt_value?: string }[]) || []) {
    if (v.txt_name) {
      records.push({
        type: 'TXT',
        name: v.txt_name,
        value: v.txt_value ?? '',
        purpose: 'Issue SSL certificate',
      });
    }
  }
  return {
    host,
    status: (ch.status as string) || 'pending',
    sslStatus: (ssl.status as string) || 'pending_validation',
    cnameTarget: cfg.fallback,
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
