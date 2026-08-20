import { describe, test, expect } from 'vitest';
import { settingsFromFiles, SETTINGS_PATH } from './settings-file';

const control = {
  id: 'radius',
  type: 'select',
  label: 'Corners',
  default: 'soft',
  options: [
    { value: 'square', label: 'Square' },
    { value: 'soft', label: 'Soft' },
  ],
};

describe('settingsFromFiles', () => {
  test('reads the theme-owned controls from config/settings.json', () => {
    const files = { [SETTINGS_PATH]: JSON.stringify({ version: 1, settings: [control] }) };
    expect(settingsFromFiles(files)).toEqual([control]);
  });

  test('a theme with no settings file exposes no controls (globals only)', () => {
    expect(settingsFromFiles({ 'sections/hero.liquid': '<section></section>' })).toEqual([]);
  });

  test('tolerates malformed input and drops invalid controls', () => {
    expect(settingsFromFiles({ [SETTINGS_PATH]: '{not json' })).toEqual([]);
    expect(settingsFromFiles({ [SETTINGS_PATH]: '[]' })).toEqual([]);
    const mixed = {
      [SETTINGS_PATH]: JSON.stringify({
        settings: [
          control,
          { id: 'baseSize', type: 'range', label: 'X', default: '1' }, // unsupported type
          { id: 'radius', type: 'select', label: 'Y', default: 'a', options: [] }, // no options
          { type: 'select', label: 'Z', default: 'a', options: [{ value: 'a', label: 'A' }] }, // no id
          {
            id: 'bogusKey',
            type: 'select',
            label: 'B',
            default: 'a',
            options: [{ value: 'a', label: 'A' }],
          }, // unknown token key
        ],
      }),
    };
    expect(settingsFromFiles(mixed).map((c) => c.id)).toEqual(['radius']);
  });
});
