// Per-theme settings schema (OFCE-711). A theme ships `config/settings.json` declaring the THEME-OWNED
// controls the editor renders for it (e.g. corners + card elevation for Forma). It rides base⊕overrides
// and versions with publish/rollback like tokens.json. The editor already has the composed files, so it
// reads the schema directly — no extra API surface. Untrusted input: a bundle's settings.json is
// tolerated and shaped here (never throws), and the values it drives are still sanitized by rootVars.
import type { ThemeFiles } from './bundle';
import type { ThemeSettingsSchema, ThemeSettingControl } from '@ratio/design-tokens';

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

// Parse a theme's settings file into a validated schema. Absent, malformed, or wrong-shaped input
// yields an empty settings list (never throws mid-render); only well-formed controls survive.
export function parseThemeSettings(raw: string | undefined | null): ThemeSettingsSchema {
  const empty: ThemeSettingsSchema = { version: 1, settings: [] };
  if (raw == null) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.settings)) return empty;
  const settings = obj.settings
    .map(parseControl)
    .filter((c): c is ThemeSettingControl => c != null);
  const version = typeof obj.version === 'number' ? obj.version : 1;
  return { version, settings };
}

// The theme-owned controls the editor should render for the given composed bundle.
export function resolveThemeSettings(
  compiled: ThemeFiles | null | undefined
): ThemeSettingControl[] {
  return parseThemeSettings(compiled?.[SETTINGS_PATH]).settings;
}
