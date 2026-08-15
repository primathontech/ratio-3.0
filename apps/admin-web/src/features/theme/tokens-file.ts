// Per-theme brand tokens live as a file in the theme bundle (config/tokens.json), edited through the
// theme's DRAFT — the same draft the code editor uses — and published via the bundle publish. These
// helpers read the tokens out of the draft's files and write them back, leaving every other file (the
// merchant's Liquid/CSS) untouched. Mirrors packages/builder-core/src/theme-tokens.ts. OFCE-616.
import type { StoreTheme, ThemeFiles } from '../../common/api';

export const TOKENS_PATH = 'config/tokens.json';

const TOKEN_KEYS = [
  'color',
  'bodyFont',
  'headingFont',
  'baseSize',
  'radius',
  'container',
] as const satisfies readonly (keyof StoreTheme)[];

// Read the brand tokens a theme carries in its bundle. Tolerant: absent, malformed, non-object, or
// wrong-typed input yields {} (the panel then falls back to its defaults); only known string keys
// survive, so an arbitrary edit to the file can't feed unexpected shapes into the form.
export function tokensFromFiles(files: ThemeFiles): StoreTheme {
  const raw = files[TOKENS_PATH];
  if (raw == null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  const out: StoreTheme = {};
  for (const k of TOKEN_KEYS) {
    if (typeof obj[k] === 'string') out[k] = obj[k] as string;
  }
  return out;
}

// Write the tokens back into the draft as config/tokens.json (pretty-printed), preserving every other
// file — the settings panel and the code editor share one draft, so a token save must never drop the
// merchant's Liquid.
export function filesWithTokens(files: ThemeFiles, tokens: StoreTheme): ThemeFiles {
  return { ...files, [TOKENS_PATH]: `${JSON.stringify(tokens, null, 2)}\n` };
}
