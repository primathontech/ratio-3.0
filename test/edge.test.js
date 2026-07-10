// Edge contracts as automated integration tests (real origin + edge on test ports,
// real test DB). Locks what was previously only covered by the manual prove.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const ORIGIN_PORT = 19090;
process.env.ORIGIN_PORT = String(ORIGIN_PORT); // must be set before requiring ../src/edge

const { serve } = require('@hono/node-server');
const { app } = require('../src/origin');
const { edge } = require('../src/edge');
const { onboardStore, deleteStore } = require('../src/onboard');
const { pool } = require('../src/db');

const SECRET = process.env.EDGE_SECRET || 'private-link-secret';
let originServer, edgeServer, edgePort;

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

before(async () => {
  await new Promise((r) => {
    originServer = serve({ fetch: app.fetch, port: ORIGIN_PORT, hostname: '127.0.0.1' }, r);
  });
  await new Promise((r) => {
    edgeServer = edge.listen(0, r);
  });
  edgePort = edgeServer.address().port;
});

after(async () => {
  await new Promise((r) => edgeServer.close(r));
  originServer.close();
  await pool.end();
});

test('host -> tenant on one shared edge', async () => {
  const a = await get(edgePort, '/', { host: 'acme.localhost' });
  assert.strictEqual(a.headers['x-tenant'], 't_acme');
  assert.match(a.body, /Acme/);
});

test('spoofed x-ratio-tenant is stripped by the edge', async () => {
  const s = await get(edgePort, '/', { host: 'acme.localhost', 'x-ratio-tenant': 't_beta' });
  assert.strictEqual(s.headers['x-tenant'], 't_acme');
});

test('unknown host -> park page (404)', async () => {
  const u = await get(edgePort, '/', { host: 'ghost.localhost' });
  assert.strictEqual(u.status, 404);
  assert.match(u.body, /Store not found/);
});

test('origin is private: a direct hit (bypassing the edge) is 403', async () => {
  const d = await get(ORIGIN_PORT, '/', { 'x-ratio-tenant': 't_acme' });
  assert.strictEqual(d.status, 403);
});

test('cacheable page: MISS then HIT (origin not re-hit)', async () => {
  await onboardStore({ id: 't_edge', name: 'EdgeCo', host: 'edgeco.localhost' });
  const first = await get(edgePort, '/', { host: 'edgeco.localhost' });
  const second = await get(edgePort, '/', { host: 'edgeco.localhost' });
  assert.strictEqual(first.headers['x-edge'], 'MISS');
  assert.strictEqual(second.headers['x-edge'], 'HIT');
  await deleteStore('t_edge');
});
