// Storefront theme layer (Slice 3). composePage injects this <style> into the page <head> so the
// first-party section classes render as a real storefront. Brand tokens (accent colour, corner
// radius) come from the tenant's theme and are sanitized before they touch CSS — a merchant value
// can never break out of the `:root` block (the storefront CSP already allows inline <style>).
import { DEFAULT_THEME_FILES } from '../theme/default-theme.generated';

// Merchant theme = a handful of GLOBAL knobs, every value chosen from a FIXED scale (consistency by
// construction). Only the brand colour is free-form; the rest are keys into the maps below, so a
// merchant can never emit an arbitrary CSS value. Anything off-scale is ignored → base default.
export interface ThemeTokens {
  color?: string; // brand colour — hex only, else ignored
  bodyFont?: string; // key of FONTS
  headingFont?: string; // key of FONTS
  baseSize?: string; // 's' | 'm' | 'l'
  radius?: string; // 'square' | 'soft' | 'rounded'
  container?: string; // 'narrow' | 'normal' | 'wide'
}

// Curated, self-hostable / websafe font stacks (no external CDN — CSP is font-src 'self' data:).
// Indic-capable self-hosted families are a follow-up; the vocabulary is ready for them.
export const FONTS: Record<string, string> = {
  system: `system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`,
  sans: `'Helvetica Neue',Arial,sans-serif`,
  serif: `Georgia,'Times New Roman',serif`,
  rounded: `'Trebuchet MS','Segoe UI',system-ui,sans-serif`,
  mono: `ui-monospace,'SF Mono',Menlo,monospace`,
};
export const BASE_SIZE: Record<string, string> = { s: '15px', m: '16px', l: '18px' };
export const RADIUS: Record<string, string> = { square: '0px', soft: '10px', rounded: '18px' };
export const CONTAINER: Record<string, string> = {
  narrow: '960px',
  normal: '1120px',
  wide: '1200px',
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Auto-derive readable text colour ON the brand fill from its luminance — the merchant picks one
// colour, we guarantee the contrast (no second knob to get wrong).
function onBrandInk(hex: string): string {
  const h = hex.slice(1);
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? '#111827' : '#ffffff';
}

// Only emit overrides that are provably safe — anything else falls back to the base defaults.
function rootVars(t: ThemeTokens): string {
  const vars: string[] = [];
  if (t.color && HEX.test(t.color)) {
    vars.push(`--accent:${t.color}`);
    vars.push(`--accent-ink:${onBrandInk(t.color)}`);
  }
  if (t.bodyFont && FONTS[t.bodyFont]) vars.push(`--font:${FONTS[t.bodyFont]}`);
  if (t.headingFont && FONTS[t.headingFont]) vars.push(`--font-heading:${FONTS[t.headingFont]}`);
  if (t.baseSize && BASE_SIZE[t.baseSize]) vars.push(`--base:${BASE_SIZE[t.baseSize]}`);
  if (t.radius && RADIUS[t.radius]) vars.push(`--radius:${RADIUS[t.radius]}`);
  if (t.container && CONTAINER[t.container]) vars.push(`--maxw:${CONTAINER[t.container]}`);
  return vars.length ? `:root{${vars.join(';')}}` : '';
}

// The design-system CSS (the .hdr/.hero/.grid/.card/.pdp/.ftr classes the theme sections are built on).
// The CSS now lives as a real, editable file (src/theme/default/assets/base.css) that the codegen inlines
// into DEFAULT_THEME_FILES; the base theme ships it as an editable asset (assets/base.css) and owns it —
// under full theme ownership the theme's layout inlines this itself (as {{ base_css }}) instead of the
// origin injecting it. Same string storefrontHead() uses, so the theme-owned head stays byte-for-byte
// identical to the legacy TS shell.
export const STOREFRONT_BASE_CSS = DEFAULT_THEME_FILES['assets/base.css'];

// The brand-token :root{} overrides for a store's chosen tokens — the MIDDLE CSS layer, between the base
// defaults and the merchant's own CSS. The origin computes this from the live theme + tenant tokens
// (resolveThemeTokens) and passes it to the layout as {{ token_css }}, exactly what storefrontHead()
// splices between BASE and the custom CSS. Values are sanitized here (rootVars) before they touch CSS.
export function tokenCss(tokens: ThemeTokens = {}): string {
  return rootVars(tokens);
}

// The full <style> block to drop into <head>: the base rules (with their default :root tokens) FIRST,
// then the store's per-theme token overrides (rootVars re-declares the same :root vars → these win the
// cascade), then the theme's own editable CSS LAST so a merchant's rules beat everything. Order is
// load-bearing: BASE ships a full `:root{…}` of defaults, so the token overrides MUST come after it or
// the defaults silently win (brand colour/font/radius never apply). customCss is the merchant's
// assets/theme.css (untrusted — the store's own CSS, inline <style> already allowed by the storefront
// CSP). Valid CSS never contains `</style`, so we neutralize it: the one way CSS could close its
// <style> element early and inject markup (the strict CSP already blocks any injected script — this is
// defense-in-depth).
export function storefrontHead(tokens: ThemeTokens = {}, customCss = ''): string {
  const safeCss = customCss.replace(/<\/style/gi, '<\\/style');
  return `<style>${STOREFRONT_BASE_CSS}${rootVars(tokens)}${safeCss}</style>`;
}
