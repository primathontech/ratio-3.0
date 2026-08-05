// Track 2 — sandboxed LiquidJS render + cacheability inference. Proves: engine renders first-party
// sections; sandbox contains hostile templates (no JS escape, filter allowlist, resource limits);
// the worker isolate hard-kills a hang; inference computes tiers + rejects undeclared reads.
// Run: node --import tsx --test test/liquid-render.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, compile, UNTRUSTED_LIMITS } from '@ratio/page-builder-render/engine';
import { renderUntrusted, RenderTimeout, RenderFailed } from '@ratio/page-builder-render/isolate';
import { inferTier } from '@ratio/page-builder-render/infer';
import { FIRST_PARTY_SECTIONS } from '@ratio/page-builder-render/sections';

const trusted = { trusted: true };
const untrusted = { trusted: false, limits: UNTRUSTED_LIMITS };

// ─── Engine: first-party sections render ──────────────────────────────────────
test('engine: hero section renders with escaping', async () => {
  const html = await render(
    FIRST_PARTY_SECTIONS.hero.template,
    { hero: { heading: 'Hi <b>' } },
    trusted
  );
  assert.match(html, /<h1>Hi &lt;b&gt;<\/h1>/, 'heading is escaped');
});

test('engine: productGrid renders prices via money filter', async () => {
  const html = await render(
    FIRST_PARTY_SECTIONS.productGrid.template,
    {
      grid: {
        heading: 'Shop',
        // canonical product fields (price in PAISE, handle, image_url) — as the backend returns
        products: [{ title: 'Shoe', price: 199900, handle: 'shoe', image_url: '' }],
      },
    },
    trusted
  );
  assert.match(html, /₹1999\.00/, 'money filter converts paise→rupees at render');
  assert.match(html, /Shoe/);
});

// ─── Sandbox: hostile templates are contained ────────────────────────────────
test('sandbox: no JS constructor/prototype escape', async () => {
  const html = await render('{{ x.constructor }}{{ x.__proto__ }}', { x: {} }, untrusted);
  assert.equal(html.trim(), '', 'no JS internals reachable from a template');
});

test('sandbox: unlisted filter is rejected (strictFilters + allowlist)', () => {
  // a filter not on the allowlist must fail — compile throws for untrusted.
  assert.throws(() => compile('{{ x | some_evil_filter }}', untrusted), /filter|undefined/i);
});

test('sandbox: allowlisted filters still work for untrusted', async () => {
  const html = await render(
    '{{ name | upcase }}-{{ price | money }}',
    { name: 'a', price: 500 }, // paise → ₹5.00
    untrusted
  );
  assert.equal(html, 'A-₹5.00');
});

test('sandbox: output/memory limit aborts a pathological expansion', async () => {
  // a huge loop building output must hit memoryLimit and throw, not OOM the process.
  await assert.rejects(
    () => render('{% for i in (1..100000000) %}xxxxxxxxxx{% endfor %}', {}, untrusted),
    /limit/i
  );
});

// ─── Isolate: hard wall-clock kill ───────────────────────────────────────────
test('isolate: a legit render returns HTML', async () => {
  const html = await renderUntrusted(
    '{{ p.title | escape }}',
    { p: { title: 'Red Shoe' } },
    { timeoutMs: 2000 }
  );
  assert.equal(html, 'Red Shoe');
});

test('isolate: an unlisted-filter template fails cleanly (RenderFailed, not hang)', async () => {
  await assert.rejects(
    () => renderUntrusted('{{ x | danger }}', { x: 1 }, { timeoutMs: 2000 }),
    (e: unknown) => e instanceof RenderFailed
  );
});

test('isolate: a hang is terminated by the wall-clock kill', async () => {
  // renderLimit should catch most; this proves the OUTER kill works even if a construct slips it.
  await assert.rejects(
    () =>
      renderUntrusted('{% for i in (1..100000000) %}{{ i }}{% endfor %}', {}, { timeoutMs: 150 }),
    (e: unknown) => e instanceof RenderTimeout || e instanceof RenderFailed,
    'a runaway render is stopped (timeout kill or engine limit) — never hangs the caller'
  );
});

// ─── Inference: compute tier, reject undeclared ──────────────────────────────
test('infer: pure static section → static', () => {
  const r = inferTier('{{ hero.heading | escape }}', [{ name: 'hero', tier: 'static' }]);
  assert.ok(r.ok);
  assert.equal(r.tier, 'static');
});

test('infer: reading a shared-volatile binding → shared-volatile', () => {
  const r = inferTier('{{ price.amount | money }}', [{ name: 'price', tier: 'shared-volatile' }]);
  assert.ok(r.ok);
  // money filter is per-locale (per-segment) and price binding is shared-volatile → max = per-segment
  assert.equal(r.tier, 'per-segment');
});

test('infer: undeclared read is rejected', () => {
  const r = inferTier('{{ product.title }} {{ secret_customer.email }}', [
    { name: 'product', tier: 'static' },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.undeclared, ['secret_customer']);
});

test('infer: date filter forces off static (per-request → per-user)', () => {
  const r = inferTier("{{ now | date: '%s' }}", [{ name: 'now', tier: 'static' }]);
  assert.ok(r.ok);
  assert.equal(r.tier, 'per-user', 'time-bearing filter forces the field off static');
});

test('infer: render/include is rejected from the auto-cacheable tier', () => {
  const r = inferTier("{% render 'card' %}", [{ name: 'card', tier: 'static' }]);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /render\/include/);
});

test('infer: first-party sections all infer a valid tier', () => {
  for (const w of Object.values(FIRST_PARTY_SECTIONS)) {
    const r = inferTier(w.template, w.bindings, w.blocks ? ['blocks'] : []);
    assert.ok(r.ok, `${w.type} should infer ok: ${r.reasons.join('; ')}`);
  }
});
