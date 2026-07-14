import http from 'http';
import type { IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'http';
import { pool } from '../packages/shared/db';

// The "edge / CDN" (Cloudflare on the real stack). Resolves host->tenant from the
// domains table (short TTL cache), injects a trusted header over a private origin,
// and holds a per-(tenant,path) cache with exact surrogate-key purge.
const EDGE_SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const ORIGIN_HOST = '127.0.0.1';
const originPort = () => Number(process.env.ORIGIN_PORT || 9090); // read lazily (test-friendly)
const HOST_TTL_MS = 5000;

const hostCache = new Map<string, { tenantId: string | null; exp: number }>();
async function resolveTenant(host: string): Promise<string | null> {
  const hit = hostCache.get(host);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.tenantId;
  const { rows } = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM domains WHERE host = $1 AND verified = true',
    [host]
  );
  const tenantId = rows[0] ? rows[0].tenant_id : null;
  hostCache.set(host, { tenantId, exp: now + HOST_TTL_MS });
  return tenantId;
}

interface CacheEntry {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  keys: Set<string>;
}
const cache = new Map<string, CacheEntry>();
const stats = { hit: 0, miss: 0, bypass: 0 };
function purge(key: string | null): number {
  let n = 0;
  for (const [k, v] of cache)
    if (key && v.keys.has(key)) {
      cache.delete(k);
      n++;
    }
  return n;
}

export const edge = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url || '/', 'http://edge');
    const path = url.pathname;

    if (path.startsWith('/__admin/')) {
      if (req.headers['x-admin-secret'] !== EDGE_SECRET) {
        res.writeHead(403);
        return res.end('admin forbidden');
      }
      if (path === '/__admin/purge') {
        const key = url.searchParams.get('key');
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ purged: purge(key), key }));
      }
      if (path === '/__admin/stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ...stats, size: cache.size }));
      }
      res.writeHead(404);
      return res.end('no such admin');
    }

    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
    const tenantId = await resolveTenant(host);
    if (!tenantId) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<h1>Store not found</h1><p>No store is configured for this domain.</p>');
    }

    const cacheKey = `${tenantId} ${path}`;
    const isGet = req.method === 'GET';

    if (isGet && cache.has(cacheKey)) {
      const entry = cache.get(cacheKey)!;
      stats.hit++;
      res.writeHead(entry.status, { ...entry.headers, 'x-edge': 'HIT' });
      return res.end(entry.body);
    }

    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers['x-ratio-tenant'];
    delete headers['x-edge-auth'];
    headers['x-ratio-tenant'] = tenantId;
    headers['x-edge-auth'] = EDGE_SECRET;
    headers.host = ORIGIN_HOST;

    const proxied = http.request(
      { host: ORIGIN_HOST, port: originPort(), method: req.method, path: req.url, headers },
      (originRes) => {
        const chunks: Buffer[] = [];
        originRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        originRes.on('end', () => {
          const body = Buffer.concat(chunks);
          let edgeState = 'BYPASS';
          if (isGet && originRes.headers['x-cache'] === 'long' && originRes.statusCode === 200) {
            const keys = new Set(
              String(originRes.headers['x-surrogate-keys'] || '')
                .split(' ')
                .filter(Boolean)
            );
            cache.set(cacheKey, {
              status: originRes.statusCode,
              headers: originRes.headers,
              body,
              keys,
            });
            stats.miss++;
            edgeState = 'MISS';
          } else {
            stats.bypass++;
          }
          res.writeHead(originRes.statusCode ?? 502, { ...originRes.headers, 'x-edge': edgeState });
          res.end(body);
        });
      }
    );
    proxied.on('error', (e: Error) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('edge -> origin error: ' + e.message);
    });
    req.pipe(proxied);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('edge error: ' + (e as Error).message);
  }
});
