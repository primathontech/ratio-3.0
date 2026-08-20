import type { ThemeFiles } from '../bundle';
import { AURA_THEME_FILES } from './aura-theme.generated';

// "Aura" — a full STANDALONE base theme (elegant, visual, beauty & lifestyle). It owns every file under
// aura/ and shares nothing with Forma but the render contract + data shapes. Edit the real files under
// aura/, then `npm run gen:themes`.
export function auraBundleTheme(): ThemeFiles {
  return { ...AURA_THEME_FILES };
}
