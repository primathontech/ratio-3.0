// Page-builder persistence (Slice 1) against a REAL Postgres (no DB mock; only the external
// purge service is faked). Proves D4 draft->publish + the durable purge outbox (D2):
// saveDraft never touches live/cache; publish promotes + bumps revision + purges; a failed
// purge is loud but durable, and drainPurges() retries it.
// Run: node --import tsx --test test/page-builder-store.test.ts

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '@ratio/shared/db';
import { PgPageStore } from '@ratio/page-builder-core/store-pg';
import { PageBuilder, PurgeFailed, type PurgeLike } from '@ratio/page-builder-core/store';
import { defaultRegistry } from '@ratio/page-builder-registry/registry';
import { pageTag } from '@ratio/page-builder-core/tags';
import type { PageDoc } from '@ratio/page-builder-core/doc';

class CountingPurge implements PurgeLike {
  calls: string[][] = [];
  fail = false;
  async invalidateByTags(tags: string[]): Promise<void> {
    if (this.fail) throw new Error('CCU 403');
    this.calls.push(tags);
  }
}

let n = 0;
const tid = () => `pbstore_${Date.now().toString(36)}_${n++}`;
const heroPage = (path: string, heading: string): PageDoc => ({
  path,
  title: 'Home',
  sections: [{ id: 'w1', type: 'hero', data: { hero: { heading } } }],
});
const heading = (doc: PageDoc): string =>
  (doc.sections[0].data.hero as { heading: string }).heading;

const world = () => {
  const store = new PgPageStore();
  const purge = new CountingPurge();
  return { store, purge, b: new PageBuilder(store, defaultRegistry(), purge) };
};

after(async () => {
  await pool.query("DELETE FROM page_purge_outbox WHERE tenant_id LIKE 'pbstore%'");
  await pool.query("DELETE FROM pages WHERE tenant_id LIKE 'pbstore%'");
  await pool.end();
});

test('saveDraft writes a draft and does NOT publish or purge', async () => {
  const { store, purge, b } = world();
  const t = tid();
  await b.saveDraft(t, heroPage('/p', 'draft one'));
  assert.equal(await store.getLive(t, '/p'), null, 'live is untouched by a save');
  const d = await store.getDraft(t, '/p');
  assert.ok(d && d.sections[0].type === 'hero', 'draft is stored');
  assert.equal(purge.calls.length, 0, 'save never purges');
  assert.equal(await store.revision(t, '/p'), 0, 'unpublished page has revision 0');
});

test('publish promotes draft to live, bumps revision, and purges the page tag', async () => {
  const { store, purge, b } = world();
  const t = tid();
  await b.saveDraft(t, heroPage('/p', 'hello'));
  const res = await b.publish(t, '/p');
  assert.deepEqual(res, { revision: 1 });
  const live = await store.getLive(t, '/p');
  assert.ok(live && heading(live) === 'hello', 'live now carries the published doc');
  assert.deepEqual(purge.calls, [[pageTag(t, '/p')]], 'purged exactly the page tag');
  assert.equal((await store.pendingPurges(t)).length, 0, 'intent marked done');
});

test('revision is monotonic across publishes', async () => {
  const { store, b } = world();
  const t = tid();
  await b.saveDraft(t, heroPage('/p', 'v1'));
  assert.deepEqual(await b.publish(t, '/p'), { revision: 1 });
  await b.saveDraft(t, heroPage('/p', 'v2'));
  assert.deepEqual(await b.publish(t, '/p'), { revision: 2 });
  assert.equal(await store.revision(t, '/p'), 2);
});

test('publish with no draft is a no-op (null, no purge)', async () => {
  const { purge, b } = world();
  const t = tid();
  assert.equal(await b.publish(t, '/never'), null);
  assert.equal(purge.calls.length, 0);
});

test('purge failure is LOUD, publish stays durable, and the outbox retries to done', async () => {
  const { store, purge, b } = world();
  const t = tid();
  await b.saveDraft(t, heroPage('/p', 'durable'));
  purge.fail = true;
  await assert.rejects(() => b.publish(t, '/p'), PurgeFailed);
  assert.ok(await store.getLive(t, '/p'), 'live promoted even though the purge failed (durable)');
  assert.equal(await store.revision(t, '/p'), 1);
  assert.equal((await store.pendingPurges(t)).length, 1, 'purge intent stays pending');

  purge.fail = false;
  assert.equal(await b.drainPurges(t), 1, 'drainPurges retries the pending intent');
  assert.deepEqual(purge.calls, [[pageTag(t, '/p')]], 'the tag finally purged');
  assert.equal((await store.pendingPurges(t)).length, 0, 'nothing left pending');
});
