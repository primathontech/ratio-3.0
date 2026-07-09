// Automated proof of the 5 things that would kill the S2 design if they failed.
// Assumes: `npm run db:up && npm run db:init` done, and `npm start` running.
const http = require('http');
const { pool } = require('../src/db');
const { forTenant } = require('../src/repo');

const EDGE = Number(process.env.EDGE_PORT || 8080);
const ORIGIN = Number(process.env.ORIGIN_PORT || 9090);

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

  // 1. Two tenants, one shared host, resolved by hostname
  const acme = await get(EDGE, '/', { host: 'acme.localhost' });
  const beta = await get(EDGE, '/', { host: 'beta.localhost' });
  check(
    '1. Two tenants on ONE shared host (hostname -> tenant)',
    acme.body.includes('Acme') && beta.body.includes('Beta') && acme.headers['x-tenant'] === 't_acme' && beta.headers['x-tenant'] === 't_beta',
    `acme->${acme.headers['x-tenant']}, beta->${beta.headers['x-tenant']}`
  );

  // 2. Spoof-proof: a client-supplied X-Ratio-Tenant is ignored (edge strips it)
  const spoof = await get(EDGE, '/', { host: 'acme.localhost', 'x-ratio-tenant': 't_beta' });
  check(
    '2. Spoof-proof (client X-Ratio-Tenant ignored)',
    spoof.headers['x-tenant'] === 't_acme',
    `forged t_beta on acme host -> served ${spoof.headers['x-tenant']}`
  );

  // 3. Origin is private: a direct hit without the edge secret is refused
  const direct = await get(ORIGIN, '/', { 'x-ratio-tenant': 't_acme' });
  check('3. Origin is private (direct request w/o edge auth -> 403)', direct.status === 403, `status=${direct.status}`);

  // 4. Tenant isolation — the make-or-break control
  const acmeSeesBeta = await forTenant('t_acme').getRoute('/about'); // /about belongs to t_beta
  check('4a. Tenant A cannot read tenant B row (repo scoped)', acmeSeesBeta === null, `acme.getRoute('/about') = ${JSON.stringify(acmeSeesBeta)}`);
  let denied = false;
  try { forTenant(undefined); } catch { denied = true; }
  check('4b. Deny-by-default (repo without tenantId throws)', denied);
  const acmeAbout = await get(EDGE, '/about', { host: 'acme.localhost' }); // beta route, over acme host
  check('4c. Cross-tenant path blocked over HTTP (acme /about -> 404)', acmeAbout.status === 404, `status=${acmeAbout.status}`);

  // 5. Data-driven routing — add a route as a DB ROW, no code change / no restart
  await forTenant('t_acme').addRoute('/diwali-sale', 'landing', { title: 'Diwali Sale', body: '50% off' });
  const newRoute = await get(EDGE, '/diwali-sale', { host: 'acme.localhost' });
  check('5. New route via DB row renders with NO rebuild', newRoute.status === 200 && newRoute.body.includes('Diwali Sale'), `status=${newRoute.status}`);

  // bonus: reserved path -> system handler; unknown host -> park page
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
})().catch((e) => {
  console.error('proof runner error:', e.message);
  process.exit(2);
});
