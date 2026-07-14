// L-7: a pre-auth /ready endpoint that probes the DB (for orchestrator readiness gating,
// distinct from the DB-free liveness /health), and store-id format validation at the
// creation boundary — a malformed id (whitespace, '/', or the '*' scope sentinel) must be
// rejected before it reaches routing, cache-purge URLs, or agent-token scopes.
import { test, after } from 'node:test';
import assert from 'node:assert';

process.env.PLATFORM_ADMIN_IDS = '';

import { createApp } from '../services/admin-api/app';
import { composeVerifiers, agentVerifier, type Verifier } from '../services/admin-api/auth';
import { pool } from '../packages/shared/db';

const v: Verifier = async (t) => (t === 'tok-x' ? { userId: 'user_l7' } : null);
const app = createApp(composeVerifiers(agentVerifier, v), { rateLimit: 1000 });

const post = (body: unknown) =>
  app.fetch(
    new Request('http://cp/stores', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-x', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

after(() => pool.end());

test('/ready is reachable without auth and reports the DB is reachable', async () => {
  const res = await app.fetch(new Request('http://cp/ready'));
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).status, 'ready');
});

test("store id '*' (scope wildcard sentinel) is rejected", async () => {
  const res = await post({ id: '*', name: 'X', host: 'x.ratiodev.in' });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /id/i);
});

test('store ids with whitespace or a slash are rejected', async () => {
  assert.strictEqual((await post({ id: 'bad id', name: 'X', host: 'x.ratiodev.in' })).status, 400);
  assert.strictEqual((await post({ id: 'a/b', name: 'X', host: 'x.ratiodev.in' })).status, 400);
  assert.strictEqual((await post({ id: 'UPPER', name: 'X', host: 'x.ratiodev.in' })).status, 400);
});

test('a well-formed id passes validation and reaches the host check', async () => {
  // Reserved apex host → 403 (not the 400 an invalid id would give): proves id validation passed.
  const res = await post({ id: 't_l7_ok', name: 'X', host: 'ratiodev.in' });
  assert.strictEqual(res.status, 403);
});
