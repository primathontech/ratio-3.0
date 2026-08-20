import type { ThemeFiles } from './bundle';
import { formaBundleTheme } from './forma-theme';
import { ATELIER_THEME_FILES } from './atelier-theme.generated';

// "Atelier" base — editorial, premium, for luxury & fashion. Same shared chrome as the Forma base
// (header/footer/layout, collection + product pages), but a different feel and home: serif typography +
// square corners, a full-width editorial hero, a split image/text feature, and a single curated product
// row. Authored as Forma composed with only its distinctive files (its config/tokens.json,
// templates/index.json, sections, and assets/atelier.css appended to the shared base.css) — edit the
// real files under src/theme/atelier/, then `npm run gen:themes`. The composed result is a complete
// root theme. Registered in BASE_THEMES as `library-editorial` (id kept for store lineage stability).
export function atelierBundleTheme(): ThemeFiles {
  const base = formaBundleTheme();
  const { 'assets/atelier.css': extraCss, ...overrides } = ATELIER_THEME_FILES;
  return {
    ...base,
    ...overrides,
    'assets/base.css': `${base['assets/base.css']}\n${extraCss ?? ''}`,
  };
}
