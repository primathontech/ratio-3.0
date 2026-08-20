// Every base in the registry must be a valid root theme that renders home/collection/product through
// the shared contract — so a store adopting ANY base works. Runs generically over BASE_THEMES, so a new
// base is covered the moment it's registered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@ratio/builder-render';
import { renderThemePage } from '../theme/theme-render';
import { StubResolver } from '../commerce/resolve';
import { BASE_THEMES } from '../theme/base-library';
import type { SectionRenderer } from '../theme/theme-render';

const theme: SectionRenderer = (liquid, data) => render(liquid, data, { trusted: true });
const page = (files: Record<string, string>, p: string, routeParams: Record<string, string> = {}) =>
  renderThemePage(
    files,
    p,
    { theme },
    { resolver: new StubResolver(), ctx: { tenantId: 't1', routeParams } }
  );

for (const base of BASE_THEMES) {
  test(`base "${base.name}" (${base.id}) is valid and renders home/collection/product`, async () => {
    const files = base.files();
    assert.match(
      files['layout/theme.liquid'],
      /\{\{\s*content_for_layout\s*\}\}/,
      'owns the sections slot'
    );
    assert.match(files['assets/base.css'], /\.hdr\b/, 'keeps the shared chrome classes');
    // Every section a template references must ship as a file.
    for (const t of Object.keys(files).filter(
      (k) => k.startsWith('templates/') && k.endsWith('.json')
    )) {
      const doc = JSON.parse(files[t]) as { sections: { type: string }[] };
      for (const s of doc.sections)
        assert.ok(
          files[`sections/${s.type}.liquid`] !== undefined,
          `${base.id}: ${t} → sections/${s.type}.liquid must exist`
        );
    }
    const home = await page(files, 'index');
    assert.match(home.html, /Sample product 1/, `${base.id} home shows products`);
    assert.match(home.html, /₹499\.00/, `${base.id} home formats prices in rupees`);
    const col = await page(files, 'collection', { handle: 'summer' });
    assert.match(col.html, /href="\/products\/sample-1"/, `${base.id} collection page works`);
    const prod = await page(files, 'product', { handle: 'air-max-90' });
    assert.match(prod.html, /Add to (cart|bag)/, `${base.id} product page works`);
  });
}

test('the lineup offers Forma / Nova / Aura / Atelier', () => {
  const names = BASE_THEMES.map((b) => b.name);
  for (const n of ['Forma', 'Nova', 'Aura', 'Atelier'])
    assert.ok(names.includes(n), `the picker offers ${n}`);
});
