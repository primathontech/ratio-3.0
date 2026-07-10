// Health/readiness probes for container orchestration (Cloud Run / K8s) — public
// (no edge-auth, no tenant), since the platform probes the container directly.
// Written test-first.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { app } from '../src/origin';
import { pool } from '../src/db';

const call = (path: string) => app.fetch(new Request('http://origin' + path));

after(() => pool.end());

test('GET /health is public and returns ok (no edge auth)', async () => {
  const res = await call('/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { status: 'ok' });
});

test('GET /ready checks the DB and reports ready when up', async () => {
  const res = await call('/ready');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ready: true });
});
