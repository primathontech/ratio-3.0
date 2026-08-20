import type { ThemeFiles } from './bundle';
import { formaBundleTheme } from './forma-theme';
import { NOVA_THEME_FILES } from './nova-theme.generated';

// "Nova" base — bold, modern, for D2C & fashion. Shared chrome from the Forma base, but a punchy home:
// a dark full-bleed hero with oversized type, a row of bold category tiles, and a "New drops" row.
// Authored as Forma composed with only its distinctive files (edit the real files under
// src/theme/nova/, then `npm run gen:themes`); assets/nova.css is appended to the shared base.css.
export function novaBundleTheme(): ThemeFiles {
  const base = formaBundleTheme();
  const { 'assets/nova.css': extraCss, ...overrides } = NOVA_THEME_FILES;
  return {
    ...base,
    ...overrides,
    'assets/base.css': `${base['assets/base.css']}\n${extraCss ?? ''}`,
  };
}
