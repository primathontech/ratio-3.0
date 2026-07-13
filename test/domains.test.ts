// Cloudflare-for-SaaS client (custom-domain connect). External service — fetch is mocked
// at the boundary; we assert the DNS records we hand the merchant, not Cloudflare itself.
import { test } from 'node:test';
import assert from 'node:assert';
import { connectCustomHostname, customHostnameStatus } from '../services/admin-api/domains';

const cfg = { token: 't', zone: 'ratiodev.in', fallback: 'service.ratiodev.in' };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function fakeCf(customHostname: unknown): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/zones?name=')) return json({ success: true, result: [{ id: 'ZID' }] });
    if (url.includes('/custom_hostnames?hostname='))
      return json({ success: true, result: [customHostname] });
    return json({ success: true, result: customHostname }); // POST create
  }) as typeof fetch;
}

const CH = {
  status: 'pending',
  ssl: {
    status: 'pending_validation',
    validation_records: [{ txt_name: '_acme.shop.example.com', txt_value: 'v1' }],
  },
  ownership_verification: { name: '_cf-custom-hostname.shop.example.com', value: 'own1' },
};

test('connectCustomHostname returns the CNAME + ownership + SSL records', async () => {
  const conn = await connectCustomHostname(cfg, 'shop.example.com', fakeCf(CH));
  assert.strictEqual(conn.cnameTarget, 'service.ratiodev.in');
  assert.strictEqual(conn.status, 'pending');
  assert.ok(conn.records.some((r) => r.type === 'CNAME' && r.value === 'service.ratiodev.in'));
  assert.ok(conn.records.some((r) => r.type === 'TXT' && r.value === 'own1'));
  assert.ok(conn.records.some((r) => r.type === 'TXT' && r.value === 'v1'));
});

test('connectCustomHostname throws on a Cloudflare error', async () => {
  const errFetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/zones?name='))
      return json({ success: true, result: [{ id: 'ZID' }] });
    return json({ success: false, errors: [{ message: 'hostname already in use' }] });
  }) as typeof fetch;
  await assert.rejects(
    () => connectCustomHostname(cfg, 'taken.example.com', errFetch),
    /already in use/
  );
});

test('normalizes host names via PSL for a multi-part TLD (.co.uk)', async () => {
  const CH2 = {
    status: 'pending',
    ssl: {
      status: 'pending_validation',
      validation_records: [{ txt_name: '_acme-challenge.brand.co.uk', txt_value: 'v' }],
    },
    ownership_verification: { name: '_cf-custom-hostname.brand.co.uk', value: 'o' },
  };
  const conn = await connectCustomHostname(cfg, 'brand.co.uk', fakeCf(CH2));
  assert.strictEqual(conn.apex, true);
  assert.strictEqual(conn.records[0].type, 'ALIAS');
  assert.strictEqual(conn.records[0].host, '@');
  // zone is brand.co.uk (not co.uk) — so the label is stripped correctly
  assert.strictEqual(conn.records.find((r) => r.value === 'o')!.host, '_cf-custom-hostname');
});

test('a subdomain on a multi-part TLD is a CNAME with the right host', async () => {
  const conn = await connectCustomHostname(cfg, 'shop.brand.co.uk', fakeCf(CH));
  assert.strictEqual(conn.apex, false);
  assert.strictEqual(conn.records[0].type, 'CNAME');
  assert.strictEqual(conn.records[0].host, 'shop');
});

test('customHostnameStatus returns null when the hostname is unknown', async () => {
  const empty = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/zones?name='))
      return json({ success: true, result: [{ id: 'ZID' }] });
    return json({ success: true, result: [] });
  }) as typeof fetch;
  assert.strictEqual(await customHostnameStatus(cfg, 'nope.example.com', empty), null);
});
