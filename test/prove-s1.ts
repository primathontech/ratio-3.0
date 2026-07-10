// Full-stack E2E proof of S1 cacheability. Run: tsx test/prove-s1.ts (servers up).
import http from 'http';
import { pool } from '../src/db';
import { forTenant } from '../src/repo';

const EDGE = Number(process.env.EDGE_PORT || 8080);
const ORIGIN = Number(process.env.ORIGIN_PORT || 9090);
const SECRET = process.env.EDGE_SECRET || 'private-link-secret';

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}
const originRenders = async (): Promise<number> =>
  JSON.parse((await get(ORIGIN, '/__stats', { 'x-edge-auth': SECRET })).body).renders;
const edgeStats = async (): Promise<{ hit: number; miss: number; bypass: number }> =>
  JSON.parse((await get(EDGE, '/__admin/stats', { 'x-admin-secret': SECRET })).body);
const doPurge = async (key: string) =>
  JSON.parse((await get(EDGE, '/__admin/purge?key=' + encodeURIComponent(key), { 'x-admin-secret': SECRET })).body);

(async () => {
  const results: { n: string; ok: boolean; d: string }[] = [];
  const check = (n: string, ok: unknown, d = '') => results.push({ n, ok: !!ok, d });

  const r0 = await originRenders();
  const edges: (string | undefined)[] = [];
  for (let i = 0; i < 5; i++) {
    const x = await get(EDGE, '/products/red-shoe', { host: 'acme.localhost' });
    edges.push(x.headers['x-edge'] as string | undefined);
  }
  const r1 = await originRenders();
  check(
    '1. Cacheable page: 5 requests -> 1 origin render (4 served from edge)',
    r1 - r0 === 1 && edges[0] === 'MISS' && edges.slice(1).every((e) => e === 'HIT'),
    `origin renders +${r1 - r0}; edge=${edges.join(',')}`
  );

  const carts: (string | undefined)[] = [];
  for (let i = 0; i < 3; i++) {
    const x = await get(EDGE, '/cart', { host: 'acme.localhost' });
    carts.push(x.headers['x-edge'] as string | undefined);
  }
  check('2. Non-cacheable (cart) always BYPASS', carts.every((e) => e === 'BYPASS'), `edge=${carts.join(',')}`);

  await get(EDGE, '/', { host: 'acme.localhost' });
  const homePre = await get(EDGE, '/', { host: 'acme.localhost' });
  await forTenant('t_acme').addRoute('/products/red-shoe', 'product', { title: 'Red Shoe v2', price: 'Rs 1799' });
  const purged = await doPurge('t:t_acme:route:/products/red-shoe');
  const prodAfter = await get(EDGE, '/products/red-shoe', { host: 'acme.localhost' });
  const homeAfter = await get(EDGE, '/', { host: 'acme.localhost' });
  check('3a. Publish purges exactly that page', prodAfter.headers['x-edge'] === 'MISS' && prodAfter.body.includes('Red Shoe v2'), `edge=${prodAfter.headers['x-edge']}, purged=${purged.purged}`);
  check('3b. Purge is EXACT — home still cached', homePre.headers['x-edge'] === 'HIT' && homeAfter.headers['x-edge'] === 'HIT', `home=${homeAfter.headers['x-edge']}`);

  const betaHome = await get(EDGE, '/', { host: 'beta.localhost' });
  check('4. Cache key is per-tenant', betaHome.body.includes('Beta') && betaHome.headers['x-tenant'] === 't_beta');

  const s = await edgeStats();
  const cacheable = s.hit + s.miss;
  const ratio = cacheable ? Math.round((s.hit / cacheable) * 100) : 0;

  console.log('\n=== S1 POC — cacheability proof ===');
  let allok = true;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '   [' + r.d + ']' : ''}`);
    if (!r.ok) allok = false;
  }
  console.log(`\nedge stats: hit=${s.hit} miss=${s.miss} bypass=${s.bypass}  ->  cache-hit ratio on cacheable = ${ratio}%`);
  console.log(allok ? 'ALL GREEN — S1 cacheability proven\n' : 'SOME FAILED\n');
  await pool.end();
  process.exit(allok ? 0 : 1);
})().catch((e: unknown) => {
  console.error('proof runner error:', (e as Error).message);
  process.exit(2);
});
