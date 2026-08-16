// mergePlatformUsers is pure — it composes the memberships-derived users with Clerk profiles.
// No DB or network here; the DB grouping + endpoint are covered by super-admin-users.test.ts.
import { test } from 'node:test';
import assert from 'node:assert';
import { mergePlatformUsers, type ClerkProfile } from '../platform-users';
import type { PlatformUserRow } from '../auth';

const dbUser = (over: Partial<PlatformUserRow>): PlatformUserRow => ({
  userId: 'user_a',
  storeCount: 1,
  joined: '2026-01-01T00:00:00.000Z',
  stores: [{ id: 't_a', name: 'A', role: 'owner' }],
  ...over,
});

const profile = (over: Partial<ClerkProfile>): ClerkProfile => ({
  userId: 'user_a',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  createdAt: Date.parse('2025-12-01T00:00:00.000Z'),
  ...over,
});

test('a store-user is enriched with their Clerk name + email', () => {
  const [u] = mergePlatformUsers([dbUser({})], [profile({})]);
  assert.strictEqual(u.name, 'Ada Lovelace');
  assert.strictEqual(u.email, 'ada@example.com');
  assert.strictEqual(u.storeCount, 1);
});

test('a store-user with no Clerk profile keeps name/email null (degraded path)', () => {
  const [u] = mergePlatformUsers([dbUser({})], []);
  assert.strictEqual(u.name, null);
  assert.strictEqual(u.email, null);
});

test('a Clerk user with no membership becomes a zero-store row', () => {
  const users = mergePlatformUsers(
    [dbUser({ userId: 'user_a' })],
    [profile({ userId: 'user_a' }), profile({ userId: 'user_z', name: 'Zoe', email: 'zoe@x.com' })]
  );
  const zoe = users.find((u) => u.userId === 'user_z');
  assert.ok(zoe, 'zero-store signup is included');
  assert.strictEqual(zoe!.storeCount, 0);
  assert.deepStrictEqual(zoe!.stores, []);
  assert.strictEqual(zoe!.name, 'Zoe');
  assert.ok(!Number.isNaN(Date.parse(zoe!.joined)), 'joined derived from Clerk createdAt');
});

test('store owners sort before zero-store sign-ups', () => {
  const users = mergePlatformUsers(
    [dbUser({ userId: 'user_a', storeCount: 1 })],
    [profile({ userId: 'user_z' })] // no membership → zero-store
  );
  assert.strictEqual(users[0].userId, 'user_a');
  assert.strictEqual(users[users.length - 1].userId, 'user_z');
});

test('a DB Date joined is normalized to an ISO string', () => {
  const [u] = mergePlatformUsers(
    [dbUser({ joined: new Date('2026-02-02T00:00:00.000Z') as unknown as string })],
    []
  );
  assert.strictEqual(u.joined, '2026-02-02T00:00:00.000Z');
});
