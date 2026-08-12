// renderThemePage composes a page from a compiled bundle, rendering each section with its own data
// via an INJECTED renderer. The tests inject in-process renderers (controlled input); at the origin,
// untrusted merchant sections use the worker-thread isolate instead — that choice being the caller's
// is the whole point of the injection. Pure (no external infra).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@ratio/builder-render';
import { renderThemePage, type SectionRenderer } from '../theme-render';
import type { ThemeFiles } from '../bundle';

const trusted: SectionRenderer = (liquid, data) => render(liquid, data, { trusted: true });
const untrusted: SectionRenderer = (liquid, data) => render(liquid, data, { trusted: false });

const hero = `<section class="hero"><h1>{{ hero.heading | escape }}</h1></section>`;
const bundle = (sections: unknown[], extra: ThemeFiles = {}): ThemeFiles => ({
  'sections/hero.liquid': hero,
  'templates/index.json': JSON.stringify({ sections }),
  ...extra,
});

test('renders a page from a compiled bundle (section liquid + its own data)', async () => {
  const compiled = bundle([{ type: 'hero', data: { hero: { heading: 'Hello' } } }]);
  assert.match(await renderThemePage(compiled, 'index', trusted), /<h1>Hello<\/h1>/);
});

test('each section renders with its OWN data (no cross-section bleed)', async () => {
  const compiled = bundle([
    { type: 'hero', data: { hero: { heading: 'One' } } },
    { type: 'hero', data: { hero: { heading: 'Two' } } },
  ]);
  const html = await renderThemePage(compiled, 'index', trusted);
  assert.match(html, /One/);
  assert.match(html, /Two/);
  assert.ok(html.indexOf('One') < html.indexOf('Two'), 'first instance renders first');
});

test('the renderer is injected — an untrusted one enforces the filter allowlist', async () => {
  const bad = bundle([{ type: 'x' }], { 'sections/x.liquid': `{{ 'a' | some_evil_filter }}` });
  await assert.rejects(() => renderThemePage(bad, 'index', untrusted));
});

test('unknown page throws', async () => {
  await assert.rejects(
    () => renderThemePage(bundle([]), 'missing', trusted),
    /no template for page/
  );
});

test('unknown section type throws', async () => {
  const c: ThemeFiles = {
    'templates/index.json': JSON.stringify({ sections: [{ type: 'ghost' }] }),
  };
  await assert.rejects(() => renderThemePage(c, 'index', trusted), /no section/);
});
