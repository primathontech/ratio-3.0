// Full-stack E2E proof of the S2 invariants. Run: tsx test/prove.ts (servers must be up).
import http from 'http';
import { pool } from '../src/db';
import { forTenant } from '../src/repo';

const EDGE = Number(process.env.EDGE_PORT || 8080);
const ORIGIN = Number(process.env.ORIGIN_PORT || 9090);

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

(async () => {
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: unknown, detail = '') => results.push({ name, ok: !!ok, detail });

  const acme = await get(EDGE, '/', { host: 'acme.localhost' });
  const beta = await get(EDGE, '/', { host: 'beta.localhost' });
  check(
    '1. Two tenants on ONE shared host (hostname -> tenant)',
    acme.body.includes('Acme') && beta.body.includes('Beta') && acme.headers['x-tenant'] === 't_acme' && beta.headers['x-tenant'] === 't_beta',
    `acme->${acme.headers['x-tenant']}, beta->${beta.headers['x-tenant']}`
  );

  const spoof = await get(EDGE, '/', { host: 'acme.localhost', 'x-ratio-tenant': 't_beta' });
  check('2. Spoof-proof (client X-Ratio-Tenant ignored)', spoof.headers['x-tenant'] === 't_acme', `served ${spoof.headers['x-tenant']}`);

  const direct = await get(ORIGIN, '/', { 'x-ratio-tenant': 't_acme' });
  check('3. Origin is private (direct request w/o edge auth -> 403)', direct.status === 403, `status=${direct.status}`);

  const acmeSeesBeta = await forTenant('t_acme').getRoute('/about');
  check('4a. Tenant A cannot read tenant B row (repo scoped)', acmeSeesBeta === null);
  let denied = false;
  try {
    forTenant(undefined as unknown as string);
  } catch {
    denied = true;
  }
  check('4b. Deny-by-default (repo without tenantId throws)', denied);
  const acmeAbout = await get(EDGE, '/about', { host: 'acme.localhost' });
  check('4c. Cross-tenant path blocked over HTTP (acme /about -> 404)', acmeAbout.status === 404, `status=${acmeAbout.status}`);

  await forTenant('t_acme').addRoute('/diwali-sale', 'landing', { title: 'Diwali Sale', body: '50% off' });
  const newRoute = await get(EDGE, '/diwali-sale', { host: 'acme.localhost' });
  check('5. New route via DB row renders with NO rebuild', newRoute.status === 200 && newRoute.body.includes('Diwali Sale'), `status=${newRoute.status}`);

  const cart = await get(EDGE, '/cart', { host: 'acme.localhost' });
  check('6. Reserved path -> system handler', cart.headers['x-handler'] === 'reserved');
  const unknown = await get(EDGE, '/', { host: 'nope.localhost' });
  check('7. Unknown host -> park page (404)', unknown.status === 404 && /Store not found/.test(unknown.body));

  console.log('\n=== S2 POC — proof of mechanism ===');
  let allok = true;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
    if (!r.ok) allok = false;
  }
  console.log(allok ? '\nALL GREEN — S2 mechanism proven\n' : '\nSOME CHECKS FAILED\n');
  await pool.end();
  process.exit(allok ? 0 : 1);
})().catch((e: unknown) => {
  console.error('proof runner error:', (e as Error).message);
  process.exit(2);
});
