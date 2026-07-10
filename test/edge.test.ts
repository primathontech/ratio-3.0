// Edge contracts as automated integration tests (real origin + edge on test ports).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { serve } from '@hono/node-server';
import { app } from '../src/origin';
import { edge } from '../src/edge';
import { onboardStore, deleteStore } from '../src/onboard';
import { pool } from '../src/db';

const ORIGIN_PORT = 19090;
process.env.ORIGIN_PORT = String(ORIGIN_PORT); // edge reads the origin port lazily (per request)

let originServer: ReturnType<typeof serve>;
let edgeServer: http.Server;
let edgePort: number;

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
      });
      req.on('error', reject);
      req.end();
    }
  );
}

before(async () => {
  await new Promise<void>((r) => {
    originServer = serve({ fetch: app.fetch, port: ORIGIN_PORT, hostname: '127.0.0.1' }, () => r());
  });
  await new Promise<void>((r) => {
    edgeServer = edge.listen(0, () => r());
  });
  edgePort = (edgeServer.address() as import('net').AddressInfo).port;
});

after(async () => {
  await new Promise<void>((r) => edgeServer.close(() => r()));
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
