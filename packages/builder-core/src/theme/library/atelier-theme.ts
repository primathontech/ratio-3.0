import type { ThemeFiles } from '../bundle';
import { ATELIER_THEME_FILES } from './atelier-theme.generated';

// "Atelier" — a full STANDALONE base theme (editorial, premium, luxury & fashion). It owns every file
// under atelier/ and shares nothing with Forma but the render contract + data shapes. Edit the real
// files under atelier/, then `npm run gen:themes`. Registered as library-editorial (id kept for lineage).
export function atelierBundleTheme(): ThemeFiles {
  return { ...ATELIER_THEME_FILES };
}
