// Design-token vocabulary — the SINGLE SOURCE OF TRUTH for the theme system (OFCE-702, epic OFCE-701).
// Two tiers (W3C DTCG model):
//   • PRIMITIVES — the fixed scales a design system is built from (spacing, radius, type, weight,
//     shadow, border). Never themed per store; baked into the base as :root defaults.
//   • SEMANTIC   — the roles components actually consume (--color-accent, --surface, --font …). A
//     store re-points THESE, never a primitive. Components must reference only semantic tokens.
// Everything is emitted as runtime CSS custom properties — NO build step. This module is the one
// place the vocabulary is defined; the storefront generator, the editor controls (OFCE-703), and the
// themes (Phase 5) all derive from it, so backend and editor can never drift.
import { FONTS } from '../storefront/storefront';

// ── Primitives ────────────────────────────────────────────────────────────────────────────────
// Fixed vocabulary. Keys are the token step; values are the literal CSS value. A 4px spacing step,
// a small radius set, a modular type scale, three weights, three shadows, one border width.
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

// ── Semantic defaults ─────────────────────────────────────────────────────────────────────────
// The roles components consume. Values are the ship-default look (Forma-ish neutral); a store's
// tokens re-point these (accent from the brand colour, etc.). Colour roles are literals; the type
// roles point at the font stacks. `leading`, `gutter`, `maxw`, `base` are layout/typography roles.
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

// Legacy var aliases → new semantic names, so a theme mid-migration can use either. The pre-token
// themes read --accent/--ink/--muted/--line/--font/--font-heading/--maxw/--base; point those at the
// new semantic vars so both vocabularies resolve to one value.
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

// The canonical default `:root{}` block — primitives + semantic defaults + legacy aliases — that a
// theme's base.css (or, later, the shared CDN stylesheet) ships in the `tokens` layer. One source,
// so every theme starts from the same scale. A store's overrides (rootVars) still win at render.
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
