// Per-theme brand tokens (OFCE-616). A theme carries its own brand tokens as a file inside its
// bundle (`config/tokens.json`) so they ride base⊕overrides, version atomically with publish/rollback,
// and travel with a duplicated/switched theme. The origin resolves the tokens for the storefront head
// from the LIVE compiled bundle, falling back to the tenant-level `tenants.theme` for any key the
// theme omits (the seed a store starts from). Untrusted input: the values are still sanitized where
// they touch CSS by `storefrontHead`/`rootVars`, so this layer only shapes and never trusts.
import type { ThemeFiles } from './bundle';
import type { ThemeTokens } from '../storefront/storefront';
import { MERCHANT_TOKEN_KEYS } from '@ratio/design-tokens';

export const TOKENS_PATH = 'config/tokens.json';

const TOKEN_KEYS = MERCHANT_TOKEN_KEYS;

// Parse a theme's tokens file into a plain, string-valued token subset. Absent, malformed, non-object,
// or wrong-typed input yields {} (never throws mid-render); only the known token keys with string
// values survive, so an arbitrary JSON blob in the bundle can't inject unexpected shapes downstream.
export function parseThemeTokens(raw: string | undefined | null): Partial<ThemeTokens> {
  if (raw == null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;
  const out: Partial<ThemeTokens> = {};
  for (const k of TOKEN_KEYS) {
    if (typeof obj[k] === 'string') out[k] = obj[k] as string;
  }
  return out;
}

// The brand tokens for the storefront head (OFCE-699): the live theme's own tokens are the DEFAULT
// look — a store adopting a theme gets that theme's palette/fonts — and an EXPLICIT merchant token in
// `tenants.theme` overrides it per key. So switching to Nova shows Nova's accent, unless the merchant
// actually chose a brand colour, which still wins. Only non-empty tenant values override (a blank must
// not shadow the theme). Untrusted input: values are still sanitized downstream by rootVars/storefrontHead.
export function resolveThemeTokens(
  compiled: ThemeFiles | null | undefined,
  tenantTheme: ThemeTokens | undefined
): ThemeTokens {
  const overrides: Partial<ThemeTokens> = {};
  for (const k of TOKEN_KEYS) {
    const v = tenantTheme?.[k];
    if (typeof v === 'string' && v.trim() !== '') overrides[k] = v;
  }
  return { ...parseThemeTokens(compiled?.[TOKENS_PATH]), ...overrides };
}
