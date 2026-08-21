import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMA_THEME_FILES } from '../theme/library/forma-theme.generated';
import { AURA_THEME_FILES } from '../theme/library/aura-theme.generated';
import { ATELIER_THEME_FILES } from '../theme/library/atelier-theme.generated';

// A merchant-authored banner image (hero/feature) routes its image_url through the asset_url filter, so
// the merchant can reference an UPLOADED asset by name ("assets/hero.png") — and an external https URL
// still passes through (asset_url returns an unknown path unchanged). Product/collection DATA images are
// already absolute CDN URLs and deliberately do NOT use asset_url.
const BANNERS: Array<[string, Record<string, string>, string]> = [
  ['forma-hero', FORMA_THEME_FILES, 'sections/forma-hero.liquid'],
  ['aura-hero', AURA_THEME_FILES, 'sections/aura-hero.liquid'],
  ['aura-ritual', AURA_THEME_FILES, 'sections/aura-ritual.liquid'],
  ['atelier editorial-hero', ATELIER_THEME_FILES, 'sections/editorial-hero.liquid'],
  ['atelier feature', ATELIER_THEME_FILES, 'sections/feature.liquid'],
];

for (const [name, files, key] of BANNERS) {
  test(`${name} routes the banner image_url through asset_url`, () => {
    assert.match(
      files[key],
      /image_url\s*\|\s*asset_url/,
      `${key} pipes image_url through asset_url`
    );
  });
}
