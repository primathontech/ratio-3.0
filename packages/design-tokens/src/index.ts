// @ratio/design-tokens — the SINGLE SOURCE OF TRUTH for the theme design-token system.
// Pure + zero-dependency on purpose: both the Node backend (@ratio/builder-core → storefront render,
// token-spec) AND the Vite admin-web (the editor's theme controls) import it, so the backend scales
// and the editor scales can never drift. (admin-web can't import @ratio/builder-core — that pulls
// Node/S3 code — but this package has no such deps, so it's safe on both sides.)
//
// Two tiers (W3C DTCG model):
//   • PRIMITIVES     — fixed platform scales (spacing/radius/type/weight/shadow/border). Theme-owned,
//                      never themed per store. Baked into the base :root via defaultTokensCss().
//   • SEMANTIC roles — what components consume (--color-accent, --surface, --font …); a store
//                      re-points these. Emitted as runtime CSS variables — no build.
// Plus the MERCHANT-OVERRIDABLE vocabulary the editor renders: a curated set of knobs where every
// value (except the brand colour) is a KEY into a fixed map below, so a merchant can never emit
// arbitrary CSS.

// ── Merchant-overridable tokens ────────────────────────────────────────────────────────────────
export interface ThemeTokens {
  color?: string; // brand colour — hex only, else ignored
  bodyFont?: string; // key of FONTS
  headingFont?: string; // key of FONTS
  baseSize?: string; // key of BASE_SIZE
  radius?: string; // key of RADIUS
  elevation?: string; // key of ELEVATION (theme-owned; only themes that bridge --elevation honour it)
}

// The canonical set of merchant-overridable token keys — the SINGLE allowlist both the backend and the
// editor filter against (tokens.json read/write, and which schema control ids are accepted), so an
// arbitrary key can never persist into a bundle or drive an unknown control.
export const MERCHANT_TOKEN_KEYS = [
  'color',
  'bodyFont',
  'headingFont',
  'baseSize',
  'radius',
  'elevation',
] as const satisfies readonly (keyof ThemeTokens)[];

// ── Value maps (merchant picks a KEY → the CSS value). Self-hostable / websafe stacks (no CDN font). ──
export const FONTS: Record<string, string> = {
  system: `system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`,
  sans: `'Helvetica Neue',Arial,sans-serif`,
  serif: `Georgia,'Times New Roman',serif`,
  rounded: `'Trebuchet MS','Segoe UI',system-ui,sans-serif`,
  mono: `ui-monospace,'SF Mono',Menlo,monospace`,
};
export const FONT_LABELS: Record<string, string> = {
  system: 'System',
  sans: 'Sans',
  serif: 'Serif',
  rounded: 'Rounded',
  mono: 'Mono',
};
export const FONT_ORDER = ['system', 'sans', 'serif', 'rounded', 'mono'] as const;

export const BASE_SIZE: Record<string, string> = { s: '15px', m: '16px', l: '18px' };
export const SIZE_LABELS: Record<string, string> = { s: 'Small', m: 'Default', l: 'Large' };
export const SIZE_ORDER = ['s', 'm', 'l'] as const;

export const RADIUS: Record<string, string> = { square: '0px', soft: '10px', rounded: '18px' };
export const RADIUS_LABELS: Record<string, string> = {
  square: 'Square',
  soft: 'Soft',
  rounded: 'Rounded',
};
export const RADIUS_ORDER = ['square', 'soft', 'rounded'] as const;

// Card elevation — a THEME-OWNED knob. rootVars emits --elevation; a theme opts in by consuming
// `var(--elevation, <its resting default>)` on its cards. Values re-point to the theme's own shadow
// scale. Forma's cards rest flat, so 'flat' (the default) resolves to none → byte-identical until the
// merchant lifts them.
export const ELEVATION: Record<string, string> = {
  flat: 'none',
  soft: 'var(--shadow-sm)',
  lifted: 'var(--shadow-md)',
};
export const ELEVATION_LABELS: Record<string, string> = {
  flat: 'Flat',
  soft: 'Soft',
  lifted: 'Lifted',
};
export const ELEVATION_ORDER = ['flat', 'soft', 'lifted'] as const;

// ── Editor: defaults + "Start from" presets + brand swatches ────────────────────────────────────
export const THEME_DEFAULTS: Required<ThemeTokens> = {
  color: '#2563eb',
  headingFont: 'system',
  bodyFont: 'system',
  baseSize: 'm',
  radius: 'soft',
  elevation: 'flat',
};

export interface ThemePreset {
  id: string;
  name: string;
  theme: Required<ThemeTokens>;
  desc: string;
}
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'default',
    name: 'Default',
    theme: { ...THEME_DEFAULTS },
    desc: 'System · soft',
  },
  {
    id: 'editorial',
    name: 'Editorial',
    theme: {
      color: '#131927',
      headingFont: 'serif',
      bodyFont: 'serif',
      baseSize: 'm',
      radius: 'square',
      elevation: 'flat',
    },
    desc: 'Serif · square',
  },
  {
    id: 'market',
    name: 'Market',
    theme: {
      color: '#E88B00',
      headingFont: 'sans',
      bodyFont: 'sans',
      baseSize: 'm',
      radius: 'rounded',
      elevation: 'flat',
    },
    desc: 'Sans · round',
  },
];
export const BRAND_SWATCHES = ['#2563eb', '#131927', '#E88B00', '#217005', '#1A2C44'];

// ── Per-theme settings schema (OFCE-710/711) ─────────────────────────────────────────────────────
// A theme ships config/settings.json declaring the THEME-OWNED controls the editor renders for it —
// e.g. corners and card elevation for Forma. Global knobs (colour/font/size/width) stay pinned in the
// editor; only these schema-declared keys vary per theme, so a control is shown only where it applies.
export type ThemeSettingType = 'select';
export interface ThemeSettingOption {
  value: string;
  label: string;
}
export interface ThemeSettingControl {
  id: string; // a ThemeTokens key the control drives, e.g. 'radius' | 'elevation'
  type: ThemeSettingType;
  label: string;
  options: ThemeSettingOption[];
  default: string;
}
export interface ThemeSettingsSchema {
  version: number;
  settings: ThemeSettingControl[];
}

// ── Primitive scales ────────────────────────────────────────────────────────────────────────────
export const PRIMITIVES = {
  space: {
    '1': '4px',
    '2': '8px',
    '3': '12px',
    '4': '16px',
    '5': '20px',
    '6': '24px',
    '8': '32px',
    '10': '40px',
    '12': '48px',
    '16': '64px',
    '20': '80px',
    '24': '96px',
  },
  radius: { none: '0', sm: '8px', md: '12px', lg: '20px', full: '999px' },
  text: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.375rem',
    '2xl': '1.75rem',
    '3xl': '2.25rem',
    '4xl': '3rem',
  },
  weight: { normal: '400', medium: '600', bold: '800' },
  shadow: {
    sm: '0 1px 2px rgba(15, 23, 42, 0.06)',
    md: '0 12px 30px rgba(15, 23, 42, 0.1)',
    lg: '0 16px 40px rgba(15, 23, 42, 0.14)',
  },
  border: { width: '1px' },
} as const;

// ── Semantic defaults (roles components consume; a store re-points these) ────────────────────────
export const SEMANTIC_DEFAULTS: Record<string, string> = {
  'color-bg': '#ffffff',
  'color-surface': '#ffffff',
  'color-ink': '#0f172a',
  'color-muted': '#64748b',
  'color-line': '#e6eaf0',
  'color-accent': '#2563eb',
  'color-accent-ink': '#ffffff',
  font: FONTS.system,
  'font-heading': FONTS.system,
  base: '16px',
  leading: '1.55',
  gutter: '24px',
  maxw: '1440px',
};

// Legacy var aliases → new semantic names, so a theme mid-migration using --accent/--r resolves.
const LEGACY_ALIASES: Record<string, string> = {
  accent: 'var(--color-accent)',
  'accent-ink': 'var(--color-accent-ink)',
  ink: 'var(--color-ink)',
  muted: 'var(--color-muted)',
  paper: 'var(--color-surface)',
  wash: 'var(--color-bg)',
  line: 'var(--color-line)',
  radius: 'var(--radius-md)',
  r: 'var(--radius-md)',
};

// The canonical default `:root{}` block (primitives + semantic + legacy aliases) a theme ships in the
// `tokens` layer. One source, so every theme starts from the same scale; a store's overrides win later.
export function defaultTokensCss(): string {
  const vars: string[] = [];
  for (const [step, v] of Object.entries(PRIMITIVES.space)) vars.push(`--space-${step}:${v}`);
  for (const [step, v] of Object.entries(PRIMITIVES.radius)) vars.push(`--radius-${step}:${v}`);
  for (const [step, v] of Object.entries(PRIMITIVES.text)) vars.push(`--text-${step}:${v}`);
  for (const [step, v] of Object.entries(PRIMITIVES.weight)) vars.push(`--weight-${step}:${v}`);
  for (const [step, v] of Object.entries(PRIMITIVES.shadow)) vars.push(`--shadow-${step}:${v}`);
  vars.push(`--border-width:${PRIMITIVES.border.width}`);
  for (const [name, v] of Object.entries(SEMANTIC_DEFAULTS)) vars.push(`--${name}:${v}`);
  for (const [name, v] of Object.entries(LEGACY_ALIASES)) vars.push(`--${name}:${v}`);
  return `:root{${vars.join(';')}}`;
}
