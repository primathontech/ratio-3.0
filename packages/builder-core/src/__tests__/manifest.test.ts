import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultWebManifest, webManifest } from '../theme/manifest';

test('defaultWebManifest: a valid installable manifest from the store name + brand colour', () => {
  const m = JSON.parse(defaultWebManifest({ name: 'Clothes', themeColor: '#2563eb' }));
  assert.equal(m.name, 'Clothes');
  assert.equal(m.short_name, 'Clothes');
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#2563eb');
  assert.equal(m.background_color, '#ffffff');
  assert.deepEqual(m.icons, [{ src: '/favicon.ico', sizes: 'any', type: 'image/x-icon' }]);
});

test('defaultWebManifest: short_name is capped at 12 chars', () => {
  const m = JSON.parse(defaultWebManifest({ name: 'A Very Long Store Name' }));
  assert.equal(m.short_name, 'A Very Long ');
  assert.equal(m.short_name.length, 12);
});

test('defaultWebManifest: a missing/invalid theme colour falls back (no injection)', () => {
  assert.equal(JSON.parse(defaultWebManifest({ name: 'S' })).theme_color, '#000000');
  assert.equal(
    JSON.parse(defaultWebManifest({ name: 'S', themeColor: 'red; }' })).theme_color,
    '#000000'
  );
  assert.equal(
    JSON.parse(defaultWebManifest({ name: 'S', themeColor: '#abc' })).theme_color,
    '#abc'
  );
});

test('webManifest: an authored file overrides any key; name/theme_color auto-fill when omitted', () => {
  // The authored file omits name + theme_color → they auto-fill from the store; it overrides display
  // and adds a new key.
  const m = JSON.parse(
    webManifest(
      { name: 'Clothes', themeColor: '#2563eb' },
      JSON.stringify({ display: 'fullscreen', orientation: 'portrait' })
    )
  );
  assert.equal(m.name, 'Clothes', 'name auto-fills from the store');
  assert.equal(m.theme_color, '#2563eb', 'theme_color auto-fills from the brand colour');
  assert.equal(m.display, 'fullscreen', 'authored key wins');
  assert.equal(m.orientation, 'portrait', 'authored can add keys');
});

test('webManifest: an authored name/theme_color deliberately override the store defaults', () => {
  const m = JSON.parse(
    webManifest(
      { name: 'Clothes', themeColor: '#2563eb' },
      JSON.stringify({ name: 'Custom PWA', theme_color: '#ff0000' })
    )
  );
  assert.equal(m.name, 'Custom PWA');
  assert.equal(m.theme_color, '#ff0000');
});

test('webManifest: a malformed or non-object authored file is ignored (serves the base)', () => {
  assert.equal(JSON.parse(webManifest({ name: 'S' }, 'not json {')).name, 'S');
  assert.equal(JSON.parse(webManifest({ name: 'S' }, '[1,2,3]')).display, 'standalone');
  assert.equal(JSON.parse(webManifest({ name: 'S' }, null)).name, 'S');
});
