import type { ThemeFiles } from '../bundle';
import { formaBundleTheme } from './forma-theme';
import { AURA_THEME_FILES } from './aura-theme.generated';

// "Aura" base — elegant, visual, for beauty & lifestyle. Shared chrome from the Forma base, but a soft,
// image-forward home: an airy centered hero, a two-panel image "duo", and a generous product row.
// Authored as Forma composed with only its distinctive files (edit the real files under src/theme/aura/,
// then `npm run gen:themes`); assets/aura.css is appended to the shared base.css.
export function auraBundleTheme(): ThemeFiles {
  const base = formaBundleTheme();
  const { 'assets/aura.css': extraCss, ...overrides } = AURA_THEME_FILES;
  return {
    ...base,
    ...overrides,
    'assets/base.css': `${base['assets/base.css']}\n${extraCss ?? ''}`,
  };
}
