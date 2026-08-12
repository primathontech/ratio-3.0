// renderThemePage composes a page from a compiled bundle using the real builder-render Liquid engine.
// Pure (in-process render) — no external infra needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderThemePage } from '../theme-render';
import type { ThemeFiles } from '../bundle';

const hero = `<section class="hero"><h1>{{ hero.heading | escape }}</h1></section>`;
const compiled: ThemeFiles = {
  'sections/hero.liquid': hero,
  'templates/index.json': JSON.stringify({ sections: [{ type: 'hero' }] }),
};

test('renders a page from a compiled bundle (section liquid + bound data)', async () => {
  const html = await renderThemePage(compiled, 'index', { hero: { heading: 'Hello' } });
  assert.match(html, /<h1>Hello<\/h1>/);
});

test('merges per-section settings into the render context', async () => {
  const withSettings: ThemeFiles = {
    'sections/hero.liquid': hero,
    'templates/index.json': JSON.stringify({
      sections: [{ type: 'hero', settings: { hero: { heading: 'From settings' } } }],
    }),
  };
  const html = await renderThemePage(withSettings, 'index');
  assert.match(html, /From settings/);
});

test('composes multiple sections in order', async () => {
  const multi: ThemeFiles = {
    'sections/a.liquid': '<p>A</p>',
    'sections/b.liquid': '<p>B</p>',
    'templates/index.json': JSON.stringify({ sections: [{ type: 'a' }, { type: 'b' }] }),
  };
  const html = await renderThemePage(multi, 'index');
  assert.ok(html.indexOf('<p>A</p>') < html.indexOf('<p>B</p>'), 'A before B');
});

test('a disallowed filter in an untrusted section is rejected', async () => {
  const bad: ThemeFiles = {
    'sections/x.liquid': `{{ 'a' | some_evil_filter }}`,
    'templates/index.json': JSON.stringify({ sections: [{ type: 'x' }] }),
  };
  await assert.rejects(() => renderThemePage(bad, 'index'));
});

test('unknown page throws', async () => {
  await assert.rejects(() => renderThemePage(compiled, 'missing'), /no template for page/);
});

test('unknown section type throws', async () => {
  const c: ThemeFiles = {
    'templates/index.json': JSON.stringify({ sections: [{ type: 'ghost' }] }),
  };
  await assert.rejects(() => renderThemePage(c, 'index'), /no section/);
});
