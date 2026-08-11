// The `render` access log is glue in the request middleware, not a domain helper, so it's tested
// end-to-end via app.fetch() with the logger pointed at a capturable destination (setLoggerForTest).
// Covers: the timing breakdown on success, the log firing on the THROW path (the review fix), and
// health probes staying out of the access log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../index';
import { setLoggerForTest } from '../log';
import { pool } from '@ratio/data-db';
import { resolveEdgeSecret } from '@ratio/edge-core';

const SECRET = resolveEdgeSecret(process.env);
const T = 't_renderlog_acme';
const HOME =
  '{"path":"/","title":"Home","sections":[{"id":"hero","type":"hero","data":{"hero":{"heading":"Hi","sub":"x"}}}]}';

// Fresh capture per test: swap the logger to push JSON lines into a local array; return the render
// records. Each file runs in its own subprocess, so swapping the module logger can't leak elsewhere.
function capture() {
  const lines: string[] = [];
  setLoggerForTest({ write: (s: string) => void lines.push(s) });
  return () => lines.map((l) => JSON.parse(l)).filter((r) => r.evt === 'render');
}

before(async () => {
  await pool.query(`INSERT INTO tenants (id,name) VALUES ($1,'RL') ON CONFLICT (id) DO NOTHING`, [
    T,
  ]);
  await pool.query(
    `INSERT INTO pages (tenant_id,path,live_doc,revision) VALUES ($1,'/',$2::jsonb,1)
     ON CONFLICT (tenant_id,path) DO NOTHING`,
    [T, HOME]
  );
});
after(async () => {
  await pool.query('DELETE FROM pages WHERE tenant_id=$1', [T]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [T]);
  await pool.end();
});

test('a successful render emits one evt:render line with the timing breakdown', async () => {
  const records = capture();
  const res = await app.fetch(
    new Request('http://origin/', { headers: { 'x-edge-auth': SECRET, 'x-ratio-tenant': T } })
  );
  assert.equal(res.status, 200);
  const rs = records();
  assert.equal(rs.length, 1, 'exactly one render line for one request');
  const [r] = rs;
  assert.equal(r.path, '/');
  assert.equal(r.status, 200);
  assert.equal(typeof r.ms, 'number');
  // The shared steps of the main render path are timed and present in the breakdown.
  assert.equal(typeof r.db_tenant, 'number');
  assert.equal(typeof r.db_page, 'number');
});

test('the render log fires on the throw path too, with status 500 (failing requests stay timed)', async () => {
  const records = capture();
  // No x-ratio-tenant → forTenant(undefined) throws → app.onError → 500. The finally must still log.
  const res = await app.fetch(
    new Request('http://origin/', { headers: { 'x-edge-auth': SECRET } })
  );
  assert.equal(res.status, 500);
  const r = records().find((x) => x.status === 500);
  assert.ok(r, 'a render line was emitted despite the throw');
  assert.equal(typeof r.ms, 'number');
});

test('/health probes are not written to the access log', async () => {
  const records = capture();
  const res = await app.fetch(new Request('http://origin/health'));
  assert.equal(res.status, 200);
  assert.equal(records().length, 0);
});
