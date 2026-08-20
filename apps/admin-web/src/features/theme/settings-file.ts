// A theme's own settings schema lives as a file in its bundle (config/settings.json) and declares the
// THEME-OWNED controls the editor should render for it (corners, card elevation …). The editor already
// loads the theme's draft files, so it reads the schema straight out of them — no extra API call.
// Mirrors packages/builder-core/src/theme/theme-settings.ts (admin-web can't import builder-core). OFCE-711.
import type { ThemeFiles } from '../../common/api';
import type { ThemeSettingControl } from '@ratio/design-tokens';

export const SETTINGS_PATH = 'config/settings.json';

function parseControl(raw: unknown): ThemeSettingControl | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.label !== 'string' || typeof c.default !== 'string') {
    return null;
  }
  if (c.type !== 'select' || !Array.isArray(c.options)) return null;
  const options = c.options
    .filter(
      (o): o is { value: string; label: string } =>
        o != null &&
        typeof o === 'object' &&
        typeof (o as Record<string, unknown>).value === 'string' &&
        typeof (o as Record<string, unknown>).label === 'string'
    )
    .map((o) => ({ value: o.value, label: o.label }));
  if (options.length === 0) return null;
  return { id: c.id, type: 'select', label: c.label, options, default: c.default };
}

// The theme-owned controls to render for this theme's draft. Tolerant: absent, malformed, or
// wrong-shaped input yields [] (the editor then shows only the global knobs), so a bad edit to the
// file can never break the settings panel.
export function settingsFromFiles(files: ThemeFiles): ThemeSettingControl[] {
  const raw = files[SETTINGS_PATH];
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const settings = (parsed as Record<string, unknown>).settings;
  if (!Array.isArray(settings)) return [];
  return settings.map(parseControl).filter((c): c is ThemeSettingControl => c != null);
}
