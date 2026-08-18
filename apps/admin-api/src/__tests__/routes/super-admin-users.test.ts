// Platform-admin users view (Slice 1): GET /admin/users groups memberships into users + their
// stores, and the store list exposes each store's ownerId. In-process via app.fetch(), real test
// DB; the Clerk verifier is injected (mock the boundary, never the DB).
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../../app';
import { pool } from '@ratio/data-db';

const ALICE = 'user_alice_sau';
const BOB = 'user_bob_sau';
const SUPER = 'user_super_sau';
process.env.PLATFORM_ADMIN_IDS = SUPER; // read lazily by auth
delete process.env.CLERK_SECRET_KEY; // keep the users view on the memberships-only path (no network)

const TOKENS: Record<string, string> = {
  'tok-alice': ALICE,
  'tok-bob': BOB,
  'tok-super': SUPER,
};
const verify = async (token: string) => (TOKENS[token] ? { userId: TOKENS[token] } : null);
const app = createApp(verify);

const alice = { authorization: 'Bearer tok-alice' };
const bob = { authorization: 'Bearer tok-bob' };
const superadmin = { authorization: 'Bearer tok-super' };

const A1 = 't_sau_a1';
const A2 = 't_sau_a2';
const B1 = 't_sau_b1';
const IDS = [A1, A2, B1];

type PlatformUser = {
  userId: string;
  storeCount: number;
  joined: string;
  stores: { id: string; name: string; role: string }[];
};

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.fetch(
    new Request('http://cp' + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
  );
}

async function cleanup() {
  for (const t of ['memberships', 'domains', 'pages', 'page_purge_outbox']) {
    await pool.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1)`, [IDS]);
  }
  await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [IDS]);
}

before(async () => {
  await cleanup();
  await call('POST', '/stores', alice, { id: A1, name: 'Alice One', host: 'sau-a1.localhost' });
  await call('POST', '/stores', alice, { id: A2, name: 'Alice Two', host: 'sau-a2.localhost' });
  await call('POST', '/stores', bob, { id: B1, name: 'Bob One', host: 'sau-b1.localhost' });
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('GET /admin/users is platform-admin only (403 for a member)', async () => {
  assert.strictEqual((await call('GET', '/admin/users', alice)).status, 403);
});

test('GET /admin/users groups every user with their stores', async () => {
  const r = await call('GET', '/admin/users', superadmin);
  assert.strictEqual(r.status, 200);
  const { users } = (await r.json()) as { users: PlatformUser[] };
  const a = users.find((u) => u.userId === ALICE);
  const b = users.find((u) => u.userId === BOB);
  assert.ok(a && b, 'both users present');
  assert.strictEqual(a!.storeCount, 2);
  assert.strictEqual(b!.storeCount, 1);
  assert.deepStrictEqual(a!.stores.map((s) => s.id).sort(), [A1, A2]);
  assert.strictEqual(a!.stores[0].role, 'owner');
  assert.ok(!Number.isNaN(Date.parse(a!.joined)), 'joined is an ISO date');
});

test('users are ordered by store count desc (alice before bob)', async () => {
  const { users } = (await (await call('GET', '/admin/users', superadmin)).json()) as {
    users: PlatformUser[];
  };
  const ai = users.findIndex((u) => u.userId === ALICE);
  const bi = users.findIndex((u) => u.userId === BOB);
  assert.ok(ai < bi, 'alice (2 stores) sorts before bob (1 store)');
});

test('the store list exposes each store’s ownerId + since for the platform view', async () => {
  const { stores } = (await (await call('GET', '/stores', superadmin)).json()) as {
    stores: { id: string; ownerId: string | null; since: string | null }[];
  };
  const a1 = stores.find((s) => s.id === A1)!;
  assert.strictEqual(a1.ownerId, ALICE);
  assert.strictEqual(stores.find((s) => s.id === B1)!.ownerId, BOB);
  assert.ok(a1.since && !Number.isNaN(Date.parse(a1.since)), 'since is a real date');
});
