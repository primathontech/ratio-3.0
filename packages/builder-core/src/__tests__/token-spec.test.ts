import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTokensCss, PRIMITIVES, SEMANTIC_DEFAULTS } from '../theme/token-spec';

test('defaultTokensCss emits a valid :root spanning every token tier', () => {
  const css = defaultTokensCss();
  assert.match(css, /^:root\{/, 'starts a :root block');
  assert.match(css, /\}$/, 'closes the block');
  // primitives — one sample per scale
  assert.ok(css.includes('--space-4:16px'), 'spacing scale');
  assert.ok(css.includes('--radius-md:12px'), 'radius scale');
  assert.ok(css.includes('--text-lg:1.125rem'), 'type scale');
  assert.ok(css.includes('--weight-bold:800'), 'weight scale');
  assert.ok(css.includes('--shadow-md:'), 'shadow scale');
  assert.ok(css.includes('--border-width:1px'), 'border');
  // semantic defaults
  assert.ok(css.includes('--color-accent:#2563eb'), 'semantic accent');
  assert.ok(css.includes('--color-ink:#0f172a'), 'semantic ink');
  assert.ok(css.includes('--maxw:1440px'), 'default container width is 1440px');
  assert.ok(css.includes('--font:'), 'body font role');
  // legacy aliases point at the new semantic vars, so a theme mid-migration using --accent/--r resolves
  assert.ok(css.includes('--accent:var(--color-accent)'), 'legacy --accent alias');
  assert.ok(css.includes('--r:var(--radius-md)'), 'legacy --r alias');
});

test('the token spec is data-driven (primitive + semantic maps are the source)', () => {
  assert.equal(PRIMITIVES.space['4'], '16px');
  assert.equal(PRIMITIVES.radius.md, '12px');
  assert.equal(SEMANTIC_DEFAULTS.maxw, '1440px');
  assert.equal(SEMANTIC_DEFAULTS['color-accent'], '#2563eb');
});
