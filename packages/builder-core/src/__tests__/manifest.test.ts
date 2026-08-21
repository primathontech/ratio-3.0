import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultWebManifest } from '../theme/manifest';

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
