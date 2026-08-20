import type { ThemeFiles } from '../bundle';
import { NOVA_THEME_FILES } from './nova-theme.generated';

// "Nova" — a full STANDALONE base theme (bold, modern, D2C & fashion). It owns every file (layout,
// header, footer, collection + product pages, sections, base.css) under nova/; it shares nothing with
// Forma but the render contract + data shapes. Edit the real files under nova/, then `npm run gen:themes`.
export function novaBundleTheme(): ThemeFiles {
  return { ...NOVA_THEME_FILES };
}
