// Round-5 audit fixes:
//   C-2 — stored XSS via unvalidated theme color interpolated into <style>
//   H-2 — onboardStore host-takeover TOCTOU (guard the upsert, not just a pre-SELECT)
//   M-7 — storefront ships no security headers (CSP / nosniff)
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-round5-secret';
process.env.PLATFORM_ADMIN_IDS = '';
process.env.EDGE_SECRET = process.env.EDGE_SECRET || 'private-link-secret';

import { renderPage } from '../packages/theme/index';
import { app as origin } from '../apps/origin/index';
import { createApp } from '../services/admin-api/app';
import { composeVerifiers, agentVerifier, type Verifier } from '../services/admin-api/auth';
import { pool } from '../packages/shared/db';

const OWNER = 'user_r5_owner';
const ATTACKER = 'user_r5_attacker';
const humans: Verifier = async (t) =>
  t === 'tok-owner' || t === 'tok-victim'
    ? { userId: OWNER }
    : t === 'tok-attacker'
      ? { userId: ATTACKER }
      : null;
const admin = createApp(composeVerifiers(agentVerifier, humans));
const SECRET = process.env.EDGE_SECRET as string;

const call = (method: string, path: string, token?: string, body?: unknown) =>
  admin.fetch(
    new Request('http://cp' + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

const TV = 't_r5_victim';
const TA = 't_r5_attacker';
const HV = 'r5victim.example.com';

async function cleanup() {
  for (const id of [TV, TA]) {
    await pool.query('DELETE FROM audit_log WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM routes WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM domains WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM tenants WHERE id=$1', [id]);
  }
}
before(async () => {
  await cleanup();
  assert.strictEqual(
    (await call('POST', '/stores', 'tok-victim', { id: TV, name: 'V', host: HV })).status,
    201
  );
  // Verified (DV-completed) domains are protected from cross-tenant takeover (H1); an
  // unverified claim is intentionally reclaimable, so mark the victim's host verified.
  await pool.query('UPDATE domains SET verified = true WHERE host = $1', [HV]);
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('C-2: renderPage neutralises a malicious theme color (no <style> breakout)', () => {
  const evil = '#000}</style><script>alert(document.cookie)</script>';
  const html = renderPage({ sections: [] }, { tenant: { name: 'Shop', theme: { color: evil } } });
  assert.ok(!html.includes('</style><script>'), 'must not break out of the style block');
  assert.ok(!html.includes('<script>alert'), 'injected script must not appear');
  assert.ok(html.includes('--accent:#111111'), 'invalid color falls back to the safe default');
});

test('C-2: POST /stores rejects a non-hex color with 400', async () => {
  const res = await call('POST', '/stores', 'tok-attacker', {
    id: TA,
    name: 'A',
    host: 'r5attacker.example.com',
    color: '#000}</style><script>alert(1)</script>',
  });
  assert.strictEqual(res.status, 400);
  const { rows } = await pool.query('SELECT id FROM tenants WHERE id=$1', [TA]);
  assert.strictEqual(rows.length, 0, 'the store must not have been created');
});

test('H-2: onboarding a store cannot take over a host owned by another tenant', async () => {
  const res = await call('POST', '/stores', 'tok-attacker', {
    id: TA,
    name: 'A',
    host: HV, // victim's host
  });
  assert.strictEqual(res.status, 409);
  const { rows } = await pool.query('SELECT tenant_id FROM domains WHERE host=$1', [HV]);
  assert.strictEqual(rows[0].tenant_id, TV, 'victim still owns the host');
});

test('M-7: the storefront sets a CSP and nosniff header', async () => {
  const res = await origin.fetch(
    new Request('http://origin/', { headers: { 'x-edge-auth': SECRET, 'x-ratio-tenant': TV } })
  );
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'none'/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
});
