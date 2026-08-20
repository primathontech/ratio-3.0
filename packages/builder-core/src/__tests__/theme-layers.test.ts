import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMA_THEME_FILES } from '../theme/library/forma-theme.generated';
import { NOVA_THEME_FILES } from '../theme/library/nova-theme.generated';
import { AURA_THEME_FILES } from '../theme/library/aura-theme.generated';
import { ATELIER_THEME_FILES } from '../theme/library/atelier-theme.generated';

// OFCE-701 Phase 1: every theme uses CSS cascade layers, so merchant/AI edits (theme.css → @layer
// overrides) always win over the base regardless of specificity — no more source-order/specificity luck.
const THEMES = [
  ['Forma', FORMA_THEME_FILES],
  ['Nova', NOVA_THEME_FILES],
  ['Aura', AURA_THEME_FILES],
  ['Atelier', ATELIER_THEME_FILES],
] as const;

for (const [name, files] of THEMES) {
  test(`${name} declares the cascade-layer order and layers its base CSS`, () => {
    const base = files['assets/base.css'];
    assert.match(
      base,
      /@layer\s+reset,\s*tokens,\s*base,\s*sections,\s*overrides;/,
      `${name} base.css must declare the shared layer order`
    );
    assert.match(base, /@layer\s+tokens\s*\{/, `${name} puts its :root tokens in @layer tokens`);
    assert.match(base, /@layer\s+base\s*\{/, `${name} puts its component rules in @layer base`);
  });

  test(`${name} routes merchant CSS through @layer overrides (edits always win)`, () => {
    const layout = files['layout/theme.liquid'];
    // theme_css is the merchant's own CSS; it must land in the last layer so it can't lose to base.
    assert.match(
      layout,
      /@layer\s+overrides\s*\{\s*\{\{\s*theme_css\s*\}\}\s*\}/,
      `${name} layout must inject theme_css inside @layer overrides`
    );
    assert.match(
      layout,
      /@layer\s+tokens\s*\{\s*\{\{\s*token_css\s*\}\}\s*\}/,
      `${name} layout must inject token_css inside @layer tokens`
    );
  });

  test(`${name} defines the uniform semantic --color-* token tier (OFCE-702)`, () => {
    const base = files['assets/base.css'];
    for (const v of [
      '--color-accent',
      '--color-accent-ink',
      '--color-ink',
      '--color-muted',
      '--color-surface',
      '--color-bg',
      '--color-line',
    ]) {
      assert.match(base, new RegExp(`${v}\\s*:`), `${name} defines the semantic ${v}`);
    }
  });
}
