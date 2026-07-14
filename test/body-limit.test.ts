// L11: a member could PUT a multi-MB pageConfig (storage/render abuse). The body-limit
// middleware caps request size before the handler runs.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../services/admin-api/app';
import { pool } from '../packages/shared/db';

after(() => pool.end());

test('rejects an oversized request body with 413 before auth/handler run', async () => {
  const app = createApp();
  const big = 'x'.repeat(1024 * 1024 + 100); // just over the 1 MB cap
  const res = await app.fetch(
    new Request('http://cp/stores', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 't_big', name: 'n', host: 'big.example.com', pad: big }),
    })
  );
  assert.strictEqual(res.status, 413);
});
