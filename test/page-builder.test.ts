// Track 4 — page builder. Proves: save-time validation (second enforcement point after
// registration, incl. rich-HTML sanitization), version pinning, durable save→purge with an
// outbox (crash-safe, retryable), shell composition (islands stay placeholders, tier = max over
// shell widgets), and the FULL D38 loop end-to-end — including the origin-owned, generation-
// ordered S3 last-good write-behind (D44) — over the real lazy-edge algorithm.
// Run: node --import tsx --test test/page-builder.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePageDoc, InvalidPageDoc, type PageDoc } from '../packages/page-builder/doc';
import {
  PageBuilder,
  InMemoryPageStore,
  InMemoryPurgeOutbox,
  PurgeFailed,
} from '../packages/page-builder/builder';
import { composePage } from '../packages/page-builder/compose';
import { PageOrigin } from '../packages/page-builder/origin-render';
import { WidgetRegistry, defaultRegistry } from '../packages/widget-registry/registry';
import { FakeAkamaiCache, type PurgeLike } from '../packages/edge-port/akamai-cache';
import { handleLazy, LIVE, type LazyEdgeDeps } from '../packages/edge-port/lazy-edge';
import { LastGoodStore } from '../packages/edge-port/last-good';
import { tenantTag, pageTag } from '../packages/edge-port/tags';
import { FakeKV, FakeR2 } from '../packages/spine/stores';
import { keyDims, r2Key } from '../packages/spine/canonical-key';

const heroPage = (path: string, heading: string): PageDoc => ({
  path,
  title: 'Home',
  widgets: [{ id: 'w1', type: 'hero', data: { hero: { heading } } }],
});

// ─── validation ──────────────────────────────────────────────────────────────

test('validate: unknown widget, undeclared data, reserved path, dup ids — all reported at once', () => {
  const reg = defaultRegistry();
  const bad: PageDoc = {
    path: '/cart/extras',
    widgets: [
      { id: 'a', type: 'ghost', data: {} },
      { id: 'b', type: 'hero', data: { hero: {}, settings: { theme: 'x' } } },
      { id: 'b', type: 'hero', data: { hero: {} } },
    ],
  };
  try {
    validatePageDoc(bad, reg);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof InvalidPageDoc);
    const all = e.problems.join(' | ');
    assert.match(all, /reserved/);
    assert.match(all, /unknown widget 'ghost'/);
    assert.match(all, /undeclared data: settings/);
    assert.match(all, /duplicate/);
  }
});

test('validate: canonicalizes the path and pins widget versions', () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(heroPage('/About//', 'hi'), reg);
  assert.equal(doc.path, '/About', 'path canonicalized like the edge key (P9 — same fn)');
  assert.equal(doc.widgets[0].version, 1, 'version pinned at save');
});

test('validate: a later widget version cannot silently change a saved page', async () => {
  const reg = new WidgetRegistry();
  reg.register(
    {
      type: 'promo',
      template: '<p>v1:{{ promo.text | escape }}</p>',
      bindings: [{ name: 'promo', tier: 'static' }],
    },
    { trusted: true }
  );
  const pinned = validatePageDoc(
    { path: '/p', widgets: [{ id: 'a', type: 'promo', data: { promo: { text: 'x' } } }] },
    reg
  );
  reg.register(
    {
      type: 'promo',
      template: '<p>v2:{{ promo.text | escape }}</p>',
      bindings: [{ name: 'promo', tier: 'static' }],
    },
    { trusted: true }
  );
  const { html } = await composePage(pinned, reg);
  assert.match(html, /v1:x/, 'pinned page still renders the version it was saved with');

  const repinned = validatePageDoc(pinned, reg);
  assert.equal(repinned.widgets[0].version, 1, 'explicit pins survive re-validation');
});

test('validate: rich HTML is sanitized AT SAVE — script/attribute vectors never reach storage (finding #8)', () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    {
      path: '/rich',
      widgets: [
        {
          id: 'r1',
          type: 'richText',
          data: {
            rich: {
              html: '<p>fine</p><script>alert(1)</script><img src=x onerror=alert(2)><b>bold</b>',
            },
          },
        },
      ],
    },
    reg
  );
  const html = (doc.widgets[0].data.rich as { html: string }).html;
  assert.match(html, /<p>fine<\/p>/, 'allowlisted formatting survives');
  assert.match(html, /<b>bold<\/b>/, 'allowlisted formatting survives');
  assert.ok(!html.includes('<script>'), 'script tag neutralized');
  assert.ok(!/<img[^&]/.test(html), 'attribute-bearing tag stays escaped');
  assert.match(html, /&lt;script&gt;/, 'escaped, not silently dropped (author sees their input)');
});

// ─── compose ─────────────────────────────────────────────────────────────────

test('compose: widgets render in order; title escapes; islands runtime ships; tier = shell max', async () => {
  const reg = defaultRegistry();
  const doc = validatePageDoc(
    {
      path: '/',
      title: 'A<b>&"shop"',
      widgets: [
        { id: 'h', type: 'hero', data: { hero: { heading: 'Hi' } } },
        { id: 'g', type: 'productGrid', data: { grid: { products: [] } } },
      ],
    },
    reg
  );
  const page = await composePage(doc, reg);
  assert.match(page.html, /<title>A&lt;b&gt;&amp;&quot;shop&quot;<\/title>/);
  assert.ok(
    page.html.indexOf('class="hero"') < page.html.indexOf('class="grid"'),
    'document order'
  );
  assert.match(page.html, /<script src="\/assets\/islands\.js" defer>/);
  assert.equal(page.tier, 'per-segment', 'grid uses money → per-segment beats hero static');
  assert.equal(page.cacheable, true);
});

test('compose: an island widget contributes ONLY its placeholder — per-user template never touches the shell', async () => {
  const reg = defaultRegistry();
  reg.register(
    {
      type: 'greeting',
      template: '<p>Hello {{ user.name | escape }}</p>',
      bindings: [{ name: 'user', tier: 'per-user' }],
      island: { name: 'greeting' },
    },
    { trusted: false }
  );
  const doc = validatePageDoc(
    {
      path: '/',
      widgets: [
        { id: 'w1', type: 'hero', data: { hero: { heading: 'Hi' } } },
        { id: 'w2', type: 'greeting', data: {} },
      ],
    },
    reg
  );
  const page = await composePage(doc, reg);
  assert.match(page.html, /<div data-island="greeting" data-params="instance=w2">/);
  assert.ok(!page.html.includes('Hello'), 'island TEMPLATE did not render into the shell');
  assert.equal(page.tier, 'static', 'island does not raise the shell tier');
});

// ─── save→purge orchestration (durable outbox, finding #7) ───────────────────

class CountingPurge implements PurgeLike {
  invalidated: string[][] = [];
  fail = false;
  async invalidateByTags(tags: string[]) {
    if (this.fail) throw new Error('CCU 403');
    this.invalidated.push(tags);
  }
  async deleteByTags() {}
}

function builderWorld() {
  const purge = new CountingPurge();
  const store = new InMemoryPageStore();
  const outbox = new InMemoryPurgeOutbox();
  const b = new PageBuilder(store, defaultRegistry(), purge, outbox);
  return { purge, store, outbox, b };
}

test('builder: save purges the page tag; themeChanged purges ONE tenant tag', async () => {
  const { purge, b } = builderWorld();
  await b.save('t_acme', heroPage('/p', 'v1'));
  assert.deepEqual(purge.invalidated[0], [pageTag('t_acme', '/p')]);
  await b.themeChanged('t_acme');
  assert.deepEqual(purge.invalidated[1], [tenantTag('t_acme')]);
});

test('builder: purge failure is LOUD, save is durable, and the OUTBOX retries it to done', async () => {
  const { purge, store, outbox, b } = builderWorld();
  purge.fail = true;
  await assert.rejects(() => b.save('t_acme', heroPage('/p', 'v1')), PurgeFailed);
  assert.ok(await store.get('t_acme', '/p'), 'content saved despite failed purge');
  assert.equal((await outbox.pending('t_acme')).length, 1, 'purge intent survives the failure');

  purge.fail = false;
  assert.equal(await b.drainPurges('t_acme'), 1, 'retry drains the pending purge');
  assert.deepEqual(purge.invalidated[0], [pageTag('t_acme', '/p')]);
  assert.equal((await outbox.pending('t_acme')).length, 0);
});

test('builder: remove is crash-safe — intent recorded BEFORE the row disappears, retry still purges', async () => {
  const { purge, b } = builderWorld();
  await b.save('t_acme', heroPage('/gone', 'x'));
  purge.invalidated.length = 0;

  purge.fail = true;
  await assert.rejects(() => b.remove('t_acme', '/gone'), PurgeFailed);
  // the row is already gone — but the tag intent is durable, so a drain still purges it
  purge.fail = false;
  assert.equal(await b.drainPurges('t_acme'), 1);
  assert.deepEqual(purge.invalidated[0], [pageTag('t_acme', '/gone')]);
});

test('builder: removing a missing page is a no-op purge-wise (nothing was ever cached)', async () => {
  const { purge, b } = builderWorld();
  assert.equal(await b.remove('t_acme', '/ghost'), false);
  assert.equal(purge.invalidated.length, 0);
});

test('store: revisions are monotonic across save/save/delete — the last-good generation source', async () => {
  const store = new InMemoryPageStore();
  const reg = defaultRegistry();
  assert.equal(await store.revision('t', '/p'), 0);
  await store.save('t', validatePageDoc(heroPage('/p', 'v1'), reg));
  assert.equal(await store.revision('t', '/p'), 1);
  await store.save('t', validatePageDoc(heroPage('/p', 'v2'), reg));
  assert.equal(await store.revision('t', '/p'), 2);
  await store.delete('t', '/p');
  assert.equal(await store.revision('t', '/p'), 3, 'deletion is a write — it gets a generation');
  await store.save('t', validatePageDoc(heroPage('/p', 'v3'), reg));
  assert.equal(await store.revision('t', '/p'), 4, 'recreate keeps counting — never regresses');
});

// ─── the full D38 loop, end-to-end over the real lazy edge ──────────────────

function pipeline() {
  const now = 1_000_000;
  const kv = new FakeKV();
  const cache = new FakeAkamaiCache(() => now);
  const registry = defaultRegistry();
  const store = new InMemoryPageStore();
  const lastGoodR2 = new FakeR2();
  const lastGood = new LastGoodStore(lastGoodR2);
  const origin = new PageOrigin(store, registry, lastGood); // origin OWNS write-behind (D44)
  const builder = new PageBuilder(store, registry, cache, new InMemoryPurgeOutbox()); // FakeAkamaiCache IS the PurgeLike
  const deps: LazyEdgeDeps = { kv, cache, lastGood, origin, colo: 'BOM' };
  const visit = (path: string) =>
    handleLazy({ method: 'GET', url: `https://acme.example${path}`, host: 'acme.example' }, deps);
  return { kv, builder, origin, lastGoodR2, visit };
}

test('e2e: publish → visit → edit → purge → revalidate — the whole D38 lifecycle', async () => {
  const p = pipeline();
  await p.kv.put('host:acme.example', JSON.stringify({ status: 'active', tenantId: 't_acme' }));

  await p.builder.save('t_acme', heroPage('/', 'Welcome v1'));
  const first = await p.visit('/');
  assert.equal(first.served, 'MISS');
  assert.match(first.body, /Welcome v1/);
  assert.equal((await p.visit('/')).served, 'HIT', 'second visit: zero origin work');
  assert.equal(p.origin.renders, 1);

  await p.builder.save('t_acme', heroPage('/', 'Welcome v2')); // edit → save → purge
  const after = await p.visit('/');
  assert.equal(after.served, 'REVALIDATED');
  assert.match(after.body, /Welcome v2/, 'the edit is live on the very next visit');
  assert.equal((await p.visit('/')).served, 'HIT');
  assert.equal(p.origin.renders, 2, 'exactly one re-render per edit');

  // D44: the origin's write-behind put v2 into S3 at generation 2
  await p.origin.settle();
  const lg = await p.lastGoodR2.get(r2Key(keyDims('t_acme', LIVE, new URL('https://x/'))));
  assert.match(lg!.body, /Welcome v2/);
  assert.equal(lg!.generation, 2);
});

test('e2e: deleted page 404s on next visit, caches, AND tombstones last-good at a newer generation', async () => {
  const p = pipeline();
  await p.kv.put('host:acme.example', JSON.stringify({ status: 'active', tenantId: 't_acme' }));
  await p.builder.save('t_acme', heroPage('/gone', 'alive'));
  await p.visit('/gone');

  await p.builder.remove('t_acme', '/gone');
  const after = await p.visit('/gone');
  assert.equal(after.status, 404, 'deleted page 404s after purge');
  assert.equal((await p.visit('/gone')).served, 'HIT', 'the 404 caches like any page');

  await p.origin.settle();
  const lg = await p.lastGoodR2.get(r2Key(keyDims('t_acme', LIVE, new URL('https://x/gone'))));
  assert.equal(lg!.status, 404, 'tombstone in S3 — outage cannot resurrect the page (D41)');
  assert.equal(lg!.generation, 2, 'tombstone generation = the delete revision, beats the old 200');
});

test('e2e: never-visited pages cost NOTHING at publish (lazy, not materialized)', async () => {
  const p = pipeline();
  await p.kv.put('host:acme.example', JSON.stringify({ status: 'active', tenantId: 't_acme' }));
  for (let i = 0; i < 50; i++) await p.builder.save('t_acme', heroPage(`/p${i}`, `page ${i}`));
  assert.equal(p.origin.renders, 0, '50 pages published, zero renders — the D38 point');
  await p.visit('/p7');
  assert.equal(p.origin.renders, 1, 'only the visited page ever renders');
});
