// Track 5 — widget registry + islands. Proves: registration is the mechanical enforcement point
// (inference gate, filter allowlist, per-user-needs-island — REQ-1/REQ-3); versions are immutable;
// untrusted widgets render only through the isolate; islands are the only per-user path and the
// shell stays byte-identical across users (C2).
// Run: node --import tsx --test test/widget-registry.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WidgetRegistry,
  WidgetRejected,
  defaultRegistry,
  renderWidget,
} from '../packages/widget-registry/registry';
import {
  islandPlaceholder,
  islandsRuntimeScript,
  IslandRegistry,
  assertIslandName,
} from '../packages/widget-registry/islands';
import { RenderTimeout } from '../packages/liquid-render/isolate';

// ─── registry: first-party preload + inferred tiers ──────────────────────────

test('defaultRegistry: first-party widgets load with INFERRED tiers (never declared)', () => {
  const reg = defaultRegistry();
  assert.equal(reg.get('hero')!.tier, 'static');
  assert.equal(reg.get('richText')!.tier, 'static');
  // productGrid + product use `| money` (per-locale filter) → per-segment, above their
  // shared-volatile bindings — the inference catching what a hand-declared tier would miss
  assert.equal(reg.get('productGrid')!.tier, 'per-segment');
  assert.equal(reg.get('product')!.tier, 'per-segment');
  assert.equal(reg.list().length, 4);
  assert.ok(reg.list().every((w) => w.trusted));
});

// ─── registry: versioning ────────────────────────────────────────────────────

test('registry: re-registering a type appends an immutable new version', () => {
  const reg = new WidgetRegistry();
  const v1 = reg.register(
    {
      type: 'promo',
      template: '<p>{{ promo.text | escape }}</p>',
      bindings: [{ name: 'promo', tier: 'static' }],
    },
    { trusted: false }
  );
  const v2 = reg.register(
    {
      type: 'promo',
      template: '<b>{{ promo.text | escape }}</b>',
      bindings: [{ name: 'promo', tier: 'static' }],
    },
    { trusted: false }
  );
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(reg.get('promo')!.version, 2, 'unpinned get = latest');
  assert.equal(
    reg.get('promo', 1)!.template,
    '<p>{{ promo.text | escape }}</p>',
    'old version intact'
  );
  assert.ok(Object.isFrozen(reg.get('promo', 1)), 'records are immutable');
});

// ─── registry: the rejection gates (REQ-1/REQ-3) ─────────────────────────────

test('registry: undeclared data read → rejected at registration', () => {
  const reg = new WidgetRegistry();
  assert.throws(
    () =>
      reg.register(
        {
          type: 'sneaky',
          template: '{{ promo.text }} {{ settings.apiKey }}',
          bindings: [{ name: 'promo', tier: 'static' }],
        },
        { trusted: false }
      ),
    (e: unknown) =>
      e instanceof WidgetRejected &&
      /undeclared data reads: settings/.test(String((e as WidgetRejected).reasons))
  );
});

test('registry: non-allowlisted filter in untrusted widget → compile rejects', () => {
  const reg = new WidgetRegistry();
  assert.throws(
    () =>
      reg.register(
        {
          type: 'f',
          template: '{{ promo.items | sort_natural }}',
          bindings: [{ name: 'promo', tier: 'static' }],
        },
        { trusted: false }
      ),
    WidgetRejected
  );
});

test('registry: render/include → rejected (unresolvable = un-analyzable)', () => {
  const reg = new WidgetRegistry();
  assert.throws(
    () =>
      reg.register(
        { type: 'inc', template: '{% render "footer" %}', bindings: [] },
        { trusted: false }
      ),
    WidgetRejected
  );
});

test('registry: per-user tier WITHOUT island → rejected; WITH island → accepted', () => {
  const reg = new WidgetRegistry();
  const input = {
    type: 'greeting',
    template: '<p>{{ user.name | escape }}</p>',
    bindings: [{ name: 'user', tier: 'per-user' as const }],
  };
  assert.throws(
    () => reg.register(input, { trusted: false }),
    (e: unknown) =>
      e instanceof WidgetRejected && /per-user content must be an island/.test((e as Error).message)
  );
  const rec = reg.register({ ...input, island: { name: 'greeting' } }, { trusted: false });
  assert.equal(rec.tier, 'per-user');
  assert.equal(rec.island!.name, 'greeting');
});

test('registry: author-declared tiers are IGNORED — the catalog decides (review blocker #5)', () => {
  const reg = new WidgetRegistry();
  // hostile author claims `user` is static to smuggle per-user bytes into the shared shell
  assert.throws(
    () =>
      reg.register(
        {
          type: 'smuggle',
          template: '<p>{{ user.name | escape }}</p>',
          bindings: [{ name: 'user', tier: 'static' as const }],
        },
        { trusted: false }
      ),
    (e: unknown) =>
      e instanceof WidgetRejected && /per-user content must be an island/.test((e as Error).message)
  );
  // and claiming `price` is static still yields shared-volatile (catalog tier wins upward too)
  const rec = reg.register(
    {
      type: 'pricey',
      template: '<span>{{ price.amount }}</span>',
      bindings: [{ name: 'price', tier: 'static' as const }],
    },
    { trusted: false }
  );
  assert.equal(rec.tier, 'shared-volatile');
  assert.equal(rec.bindings[0].tier, 'shared-volatile', 'stored binding carries the catalog tier');
});

test('registry: TRUSTED widgets are held to the filter allowlist too (finding #9)', () => {
  const reg = new WidgetRegistry();
  // an unlisted filter contributes no tier to inference — accepting it would silently corrupt
  // cacheability classification, trusted or not
  assert.throws(
    () =>
      reg.register(
        {
          type: 'fp',
          template: '{{ promo.items | sort_natural }}',
          bindings: [{ name: 'promo', tier: 'static' as const }],
        },
        { trusted: true }
      ),
    (e: unknown) =>
      e instanceof WidgetRejected &&
      /non-allowlisted filters: sort_natural/.test((e as Error).message)
  );
});

test('registry: records are DEEP-frozen — bindings/island cannot be mutated after the gate', () => {
  const reg = new WidgetRegistry();
  const rec = reg.register(
    {
      type: 'promo',
      template: '<p>{{ promo.text | escape }}</p>',
      bindings: [{ name: 'promo', tier: 'static' as const }],
      island: { name: 'promo-live' },
    },
    { trusted: false }
  );
  assert.ok(Object.isFrozen(rec.bindings), 'bindings array frozen');
  assert.ok(Object.isFrozen(rec.bindings[0]), 'binding entries frozen');
  assert.ok(Object.isFrozen(rec.island), 'island config frozen');
  assert.throws(() => {
    (rec.bindings as { name: string; tier: string }[])[0].tier = 'static';
  }, TypeError);
});

// ─── rendering: trust decides the path ───────────────────────────────────────

test('renderWidget: untrusted renders through the isolate; a hang is hard-killed (D40)', async () => {
  const reg = new WidgetRegistry();
  const ok = reg.register(
    {
      type: 'p',
      template: '<p>{{ promo.text | escape }}</p>',
      bindings: [{ name: 'promo', tier: 'static' }],
    },
    { trusted: false }
  );
  assert.equal(await renderWidget(ok, { promo: { text: 'hi <b>' } }), '<p>hi &lt;b&gt;</p>');

  // a template that passes registration (declared reads, allowed filters) but hangs at render
  // time on pathological data — the isolate, not the engine, is what contains it
  const spin = reg.register(
    {
      type: 'spin',
      template:
        '{% for a in promo.items %}{% for b in promo.items %}{% for c in promo.items %}{% for d in promo.items %}x{% endfor %}{% endfor %}{% endfor %}{% endfor %}',
      bindings: [{ name: 'promo', tier: 'static' }],
    },
    { trusted: false }
  );
  const big = Array.from({ length: 300 }, (_, i) => i);
  await assert.rejects(
    () => renderWidget(spin, { promo: { items: big } }),
    (e: unknown) => e instanceof RenderTimeout || e instanceof Error
  );
});

// ─── islands ─────────────────────────────────────────────────────────────────

test('islands: placeholder escapes params; names are a closed alphabet', () => {
  const html = islandPlaceholder('add-to-cart', { sku: 'A1<script>' });
  assert.match(html, /^<div data-island="add-to-cart" data-params="sku=A1/);
  assert.ok(!html.includes('<script>'), 'params are escaped into the attribute');
  assert.throws(() => islandPlaceholder('Bad Name'), /invalid island name/);
  assert.throws(() => assertIslandName('x/../y'), /invalid island name/);
});

test('islands: responses are ALWAYS no-store+private; a handler crash degrades to empty', async () => {
  const isl = new IslandRegistry();
  isl.register('add-to-cart', async ({ params, userId }) => ({
    html: `<button data-sku="${params.get('sku')}">${userId ? 'Buy again' : 'Add to cart'}</button>`,
  }));
  isl.register('boom', async () => {
    throw new Error('backend down');
  });

  const ok = await isl.handle('add-to-cart', new URLSearchParams('sku=A1'), 'u_1');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store, private');
  assert.match(ok.body, /Buy again/);

  const missing = await isl.handle('ghost', new URLSearchParams(), null);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['cache-control'], 'no-store, private');

  const crashed = await isl.handle('boom', new URLSearchParams(), null);
  assert.equal(crashed.status, 500);
  assert.equal(crashed.body, '', 'island failure = empty slot, never a page error');
});

test('islands: runtime script is CSP-self clean — no external origins, no eval, no inline handlers', () => {
  const js = islandsRuntimeScript();
  assert.ok(!/https?:\/\//.test(js), 'no absolute origins — same-origin fetches only');
  assert.ok(!/\beval\b|\bFunction\s*\(/.test(js), 'no dynamic code');
  assert.match(js, /credentials:\s*'same-origin'/);
  assert.match(js, /\/api\/island\//, 'hydrates from the reserved path the edge never caches');
});

// ─── C2: the shell is byte-identical across users; personalisation is island-only ─

test('C2: shell bytes identical for two users; island responses differ', async () => {
  const reg = defaultRegistry();
  const product = reg.get('product')!;
  const data = { product: { title: 'Shoe', sku: 'A1' }, price: { amount: 999 } };

  // "two users" render the same shell — user identity is not even an input to the shell render
  const shellA = await renderWidget(product, data);
  const shellB = await renderWidget(product, data);
  assert.equal(shellA, shellB, 'shared shell carries zero per-user bytes');
  assert.match(shellA, /data-island="add-to-cart"/, 'per-user part is a placeholder');

  const isl = new IslandRegistry();
  isl.register('add-to-cart', async ({ userId }) => ({
    html: userId ? `<button>Buy again, ${userId}</button>` : '<button>Add to cart</button>',
  }));
  const a = await isl.handle('add-to-cart', new URLSearchParams('sku=A1'), 'u_alice');
  const b = await isl.handle('add-to-cart', new URLSearchParams('sku=A1'), null);
  assert.notEqual(a.body, b.body, 'personalisation exists ONLY behind the island endpoint');
});
