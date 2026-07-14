// OFCE-406 (audit M-1): the control plane must throttle per user, with a tighter budget on
// /assistant. Plus L-3: an idle-client pool error must not crash the process.
import { test, after } from 'node:test';
import assert from 'node:assert';

process.env.PLATFORM_ADMIN_IDS = '';

import { createApp } from '../services/admin-api/app';
import { composeVerifiers, agentVerifier, type Verifier } from '../services/admin-api/auth';
import { pool } from '../packages/shared/db';

const v: Verifier = async (t) => (t === 'tok-x' ? { userId: 'user_rl' } : null);
const caller =
  (app: ReturnType<typeof createApp>) =>
  (path: string, method = 'GET') =>
    app.fetch(
      new Request('http://cp' + path, { method, headers: { authorization: 'Bearer tok-x' } })
    );

after(() => pool.end());

test('control-plane throttles a user past the per-user budget (429)', async () => {
  const app = createApp(composeVerifiers(agentVerifier, v), { rateLimit: 2 });
  const call = caller(app);
  assert.strictEqual((await call('/me')).status, 200);
  assert.strictEqual((await call('/me')).status, 200);
  assert.strictEqual((await call('/me')).status, 429);
});

test('/assistant draws from its own tighter budget', async () => {
  const app = createApp(composeVerifiers(agentVerifier, v), { assistantRateLimit: 2 });
  const call = caller(app);
  const s1 = (await call('/assistant', 'POST')).status;
  const s2 = (await call('/assistant', 'POST')).status;
  const s3 = (await call('/assistant', 'POST')).status;
  assert.notStrictEqual(s1, 429); // allowed by the limiter (then 503 — no key configured)
  assert.notStrictEqual(s2, 429);
  assert.strictEqual(s3, 429); // over the tighter /assistant budget
});

test('L-1: in-process (viaSelf) calls carrying the internal marker skip the limiter', async () => {
  const app = createApp(composeVerifiers(agentVerifier, v), {
    rateLimit: 1,
    internalToken: 'itok',
  });
  const internal = () =>
    app.fetch(
      new Request('http://cp/me', {
        headers: { authorization: 'Bearer tok-x', 'x-ratio-internal': 'itok' },
      })
    );
  // Well past rateLimit:1 — none of these are throttled, and none consume the user's budget.
  assert.strictEqual((await internal()).status, 200);
  assert.strictEqual((await internal()).status, 200);
  assert.strictEqual((await internal()).status, 200);
  // A forged/absent marker still counts: the one real request is allowed, the next is 429.
  const external = caller(app);
  assert.strictEqual((await external('/me')).status, 200);
  assert.strictEqual((await external('/me')).status, 429);
});

test('L-3: an idle-client pool error is handled, not fatal', () => {
  assert.doesNotThrow(() => pool.emit('error', new Error('idle client boom')));
});
