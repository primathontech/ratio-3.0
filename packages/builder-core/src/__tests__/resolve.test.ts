import { test } from 'node:test';
import assert from 'node:assert';
import { resolvePage, interpolateParams, StubResolver } from '../resolve';
import type { BindingResolver, ResolvedSource } from '../resolve';
import { defaultRegistry } from '@ratio/builder-registry';
import type { PageDoc, DataSource } from '../doc';

const registry = defaultRegistry();
const resolver = new StubResolver();

test('interpolateParams fills {{params.x}} from route params (deep)', () => {
  const out = interpolateParams(
    { handle: '{{params.handle}}', handles: ['{{params.handle}}', 'static'] },
    { handle: 'summer' }
  );
  assert.deepStrictEqual(out, { handle: 'summer', handles: ['summer', 'static'] });
});

test('a page with no dataSources passes through unchanged, no tags', async () => {
  const doc: PageDoc = {
    path: '/',
    title: 'x',
    sections: [{ id: 'h', type: 'heading', data: { heading: { text: 'Hi' } } }],
  };
  const { doc: out, tags } = await resolvePage(doc, registry, resolver, { tenantId: 't' });
  assert.strictEqual(out, doc); // same reference — nothing to do
  assert.deepStrictEqual(tags, []);
});

test('resolvePage injects collection products into the productGrid binding + emits tags', async () => {
  const doc: PageDoc = {
    path: '/collections/:handle',
    title: 'Collection',
    dataSources: {
      main: {
        type: 'COLLECTION_BY_HANDLES',
        params: { handles: ['{{params.handle}}'], productLimit: 3 },
      },
    },
    sections: [
      { id: 'g', type: 'productGrid', dataSourceKey: 'main', data: { grid: { heading: 'Shop' } } },
    ],
  };
  const { doc: out, tags } = await resolvePage(doc, registry, resolver, {
    tenantId: 't',
    routeParams: { handle: 'summer' },
  });
  const grid = out.sections[0].data.grid as { heading: string; products: unknown[] };
  assert.strictEqual(grid.heading, 'Shop'); // config preserved
  assert.strictEqual(grid.products.length, 3); // resolved data injected
  assert.ok(tags.includes('col:summer'), 'collection tag from the interpolated handle');
});

test('resolvePage injects the canonical product into the PDP product binding (raw, unmodified)', async () => {
  const doc: PageDoc = {
    path: '/products/:handle',
    title: 'PDP',
    dataSources: { main: { type: 'PRODUCT', params: { handle: '{{params.handle}}' } } },
    sections: [{ id: 'p', type: 'product', dataSourceKey: 'main', data: {} }],
  };
  const { doc: out } = await resolvePage(doc, registry, resolver, {
    tenantId: 't',
    routeParams: { handle: 'shoe' },
  });
  const data = out.sections[0].data as { product: { title: string; price: number } };
  assert.match(data.product.title, /shoe/); // canonical product on the product binding
  assert.strictEqual(data.product.price, 99900); // raw paise, NOT converted (transform is at render)
});

test('the saved doc is not mutated — injection is render-only', async () => {
  const doc: PageDoc = {
    path: '/',
    title: 'x',
    dataSources: { main: { type: 'COLLECTION_BY_HANDLES', params: { handles: ['a'] } } },
    sections: [{ id: 'g', type: 'productGrid', dataSourceKey: 'main', data: { grid: {} } }],
  };
  await resolvePage(doc, registry, resolver, { tenantId: 't' });
  assert.strictEqual((doc.sections[0].data.grid as Record<string, unknown>).products, undefined);
});

test('resolvePage fans out in parallel but caps concurrency at 6 (Workers connection window)', async () => {
  // A probe resolver that records the max number of simultaneously in-flight fetches.
  class ConcurrencyProbe implements BindingResolver {
    inFlight = 0;
    max = 0;
    async fetch(): Promise<ResolvedSource> {
      this.inFlight++;
      this.max = Math.max(this.max, this.inFlight);
      await new Promise((r) => setTimeout(r, 5)); // hold the "connection" so overlaps are real
      this.inFlight--;
      return { value: {}, tags: [] };
    }
  }
  const probe = new ConcurrencyProbe();
  const sources: Record<string, DataSource> = {};
  for (let i = 0; i < 15; i++) sources[`s${i}`] = { type: 'PRODUCT', params: {} };
  const doc: PageDoc = { path: '/', title: 'x', dataSources: sources, sections: [] };

  await resolvePage(doc, registry, probe, { tenantId: 't' });

  assert.ok(probe.max <= 6, `never more than 6 in flight (saw ${probe.max})`);
  assert.strictEqual(probe.max, 6, `should saturate the window with 15 sources (saw ${probe.max})`);
});
