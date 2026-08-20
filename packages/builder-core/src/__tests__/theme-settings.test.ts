import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThemeSettings, resolveThemeSettings, SETTINGS_PATH } from '../theme/theme-settings';
import { FORMA_THEME_FILES } from '../theme/library/forma-theme.generated';
import { NOVA_THEME_FILES } from '../theme/library/nova-theme.generated';

test('Forma ships a settings schema declaring its theme-owned controls', () => {
  const controls = resolveThemeSettings(FORMA_THEME_FILES);
  assert.deepEqual(
    controls.map((c) => c.id),
    ['radius', 'elevation'],
    'Forma exposes corners + card elevation'
  );
  const elevation = controls.find((c) => c.id === 'elevation');
  assert.equal(elevation?.type, 'select');
  assert.equal(elevation?.default, 'flat');
  assert.deepEqual(
    elevation?.options.map((o) => o.value),
    ['flat', 'soft', 'lifted']
  );
});

test('a theme without a settings file exposes no theme-owned controls (globals only)', () => {
  assert.equal(NOVA_THEME_FILES[SETTINGS_PATH], undefined, 'Nova ships no settings.json');
  assert.deepEqual(resolveThemeSettings(NOVA_THEME_FILES), []);
});

test('parseThemeSettings tolerates malformed input (never throws)', () => {
  assert.deepEqual(parseThemeSettings(undefined), { version: 1, settings: [] });
  assert.deepEqual(parseThemeSettings('not json {'), { version: 1, settings: [] });
  assert.deepEqual(parseThemeSettings('[]'), { version: 1, settings: [] });
  // drops controls missing required fields or with an empty/invalid option set
  const partial = JSON.stringify({
    version: 1,
    settings: [
      {
        id: 'ok',
        type: 'select',
        label: 'OK',
        default: 'a',
        options: [{ value: 'a', label: 'A' }],
      },
      { id: 'noOptions', type: 'select', label: 'X', default: 'a', options: [] },
      { id: 'wrongType', type: 'range', label: 'X', default: '1' },
      { label: 'noId', type: 'select', default: 'a', options: [{ value: 'a', label: 'A' }] },
    ],
  });
  assert.deepEqual(
    parseThemeSettings(partial).settings.map((c) => c.id),
    ['ok']
  );
});
