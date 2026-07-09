const http = require('http');
const { pool } = require('./db');

// The "edge / CDN". S2: resolves hostname -> tenantId (from the DB `domains` table,
// cached in-memory with a short TTL = decision #3: push-on-change + TTL fallback),
// injects the trusted header. S1: an edge CACHE keyed by (tenantId, path) with
// exact surrogate-key PURGE. Cache key includes the tenant → caches never cross tenants.
const EDGE_SECRET = process.env.EDGE_SECRET || 'private-link-secret';
const ORIGIN = { host: '127.0.0.1', port: Number(process.env.ORIGIN_PORT || 9090) };
const HOST_TTL_MS = 5000;

const hostCache = new Map(); // host -> { tenantId, exp }
async function resolveTenant(host) {
  const hit = hostCache.get(host);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.tenantId;
  const { rows } = await pool.query('SELECT tenant_id FROM domains WHERE host = $1', [host]);
  const tenantId = rows[0] ? rows[0].tenant_id : null;
  hostCache.set(host, { tenantId, exp: now + HOST_TTL_MS });
  return tenantId;
}

const cache = new Map(); // "tenantId path" -> { status, headers, body, keys:Set }
const stats = { hit: 0, miss: 0, bypass: 0 };
function purge(key) {
  let n = 0;
  for (const [k, v] of cache) if (v.keys.has(key)) { cache.delete(k); n++; }
  return n;
}

const edge = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://edge');
    const path = url.pathname;

    // out-of-band admin (models outbox->CDN purge + a stats probe)
    if (path.startsWith('/__admin/')) {
      if (req.headers['x-admin-secret'] !== EDGE_SECRET) { res.writeHead(403); return res.end('admin forbidden'); }
      if (path === '/__admin/purge') {
        const key = url.searchParams.get('key');
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ purged: purge(key), key }));
      }
      if (path === '/__admin/stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ...stats, size: cache.size }));
      }
      res.writeHead(404); return res.end('no such admin');
    }

    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
    const tenantId = await resolveTenant(host);
    if (!tenantId) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<h1>Store not found</h1><p>No store is configured for this domain.</p>');
    }

    const cacheKey = `${tenantId} ${path}`;
    const isGet = req.method === 'GET';

    if (isGet && cache.has(cacheKey)) {
      const entry = cache.get(cacheKey);
      stats.hit++;
      res.writeHead(entry.status, { ...entry.headers, 'x-edge': 'HIT' });
      return res.end(entry.body);
    }

    const headers = { ...req.headers };
    delete headers['x-ratio-tenant'];
    delete headers['x-edge-auth'];
    headers['x-ratio-tenant'] = tenantId;
    headers['x-edge-auth'] = EDGE_SECRET;
    headers.host = ORIGIN.host;

    const proxied = http.request(
      { host: ORIGIN.host, port: ORIGIN.port, method: req.method, path: req.url, headers },
      (originRes) => {
        const chunks = [];
        originRes.on('data', (c) => chunks.push(c));
        originRes.on('end', () => {
          const body = Buffer.concat(chunks);
          let edgeState = 'BYPASS';
          if (isGet && originRes.headers['x-cache'] === 'long' && originRes.statusCode === 200) {
            const keys = new Set((originRes.headers['x-surrogate-keys'] || '').split(' ').filter(Boolean));
            cache.set(cacheKey, { status: originRes.statusCode, headers: originRes.headers, body, keys });
            stats.miss++; edgeState = 'MISS';
          } else { stats.bypass++; }
          res.writeHead(originRes.statusCode, { ...originRes.headers, 'x-edge': edgeState });
          res.end(body);
        });
      }
    );
    proxied.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('edge -> origin error: ' + e.message); });
    req.pipe(proxied);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('edge error: ' + e.message);
  }
});

module.exports = { edge };
