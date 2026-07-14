// L-2: when a caller doesn't supply an idempotency key, derive a stable one from the request
// content (user + store + message) so an accidental double-submit of the identical request
// still dedupes instead of re-running the assistant and duplicating stores/pages.
import { test } from 'node:test';
import assert from 'node:assert';
import { createIdempotencyStore, idempotencyKeyFor } from '../services/admin-api/idempotency';

test('a client-supplied key takes precedence and is namespaced per user', () => {
  assert.strictEqual(
    idempotencyKeyFor({ userId: 'u1', message: 'x', clientKey: 'abc' }),
    'k:u1:abc'
  );
});

test('without a client key, identical (user, store, message) derive the same key (trimmed)', () => {
  const a = idempotencyKeyFor({ userId: 'u1', storeId: 's1', message: '  build a hero  ' });
  const b = idempotencyKeyFor({ userId: 'u1', storeId: 's1', message: 'build a hero' });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, 'k:u1:build a hero'); // it's a hash, not the raw message
});

test('the derived key differs by user, store, and message', () => {
  const base = { userId: 'u1', storeId: 's1', message: 'm' };
  const k = idempotencyKeyFor(base);
  assert.notStrictEqual(k, idempotencyKeyFor({ ...base, userId: 'u2' }));
  assert.notStrictEqual(k, idempotencyKeyFor({ ...base, storeId: 's2' }));
  assert.notStrictEqual(k, idempotencyKeyFor({ ...base, message: 'm2' }));
});

test('a client key and a content key never collide (namespaced)', () => {
  const client = idempotencyKeyFor({ userId: 'u1', message: 'm', clientKey: 'k1' });
  const content = idempotencyKeyFor({ userId: 'u1', storeId: 's1', message: 'm' });
  assert.notStrictEqual(client, content);
});

test('content-derived keys dedupe identical retries with no client key (L-2)', async () => {
  const idem = createIdempotencyStore();
  let runs = 0;
  const send = (message: string) =>
    idem.run(idempotencyKeyFor({ userId: 'u1', storeId: 's1', message }), async () => {
      runs++;
      return message.length;
    });
  await send('add a page');
  await send('add a page');
  assert.strictEqual(runs, 1); // the second identical request re-used the first
  await send('add a different page');
  assert.strictEqual(runs, 2);
});
