// The default starter theme must be VALID against the origin render contract (theme-render.ts): the
// layout holds the content slot, and every templates/*.json is parseable and references sections that
// actually exist as sections/<type>.liquid — otherwise a freshly-seeded store fails to render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBundleTheme } from '../default-theme';

test('default theme: layout holds content_for_layout and templates reference existing sections', () => {
  const files = defaultBundleTheme();

  assert.match(files['layout/theme.liquid'], /\{\{\s*content_for_layout\s*\}\}/);

  const templates = Object.keys(files).filter(
    (p) => p.startsWith('templates/') && p.endsWith('.json')
  );
  assert.ok(templates.includes('templates/index.json'), 'has a home template');

  for (const t of templates) {
    const doc = JSON.parse(files[t]) as { sections: { type: string }[] };
    assert.ok(Array.isArray(doc.sections) && doc.sections.length > 0, `${t} lists sections`);
    for (const s of doc.sections) {
      assert.ok(
        files[`sections/${s.type}.liquid`] !== undefined,
        `${t} references sections/${s.type}.liquid which must exist`
      );
    }
  }
});
