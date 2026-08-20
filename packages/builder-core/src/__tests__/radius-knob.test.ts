import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOREFRONT_BASE_CSS, tokenCss } from '../storefront/storefront';
import { AURA_THEME_FILES } from '../theme/library/aura-theme.generated';

// Resolve a CSS custom property through the cascade: collect every `--name: value` declaration in
// document order (later wins, like the cascade for same-specificity :root rules — and rootVars is
// appended last), then follow var(--x, fallback) chains. This checks the OBSERVABLE effect (does the
// merchant radius knob reach the variable a theme's rules actually consume), not the source text.
function resolveVar(css: string, name: string): string {
  const map = new Map<string, string>();
  const re = /--([\w-]+)\s*:\s*([^;{}]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) map.set(m[1], m[2].trim());

  const seen = new Set<string>();
  const resolve = (raw: string | undefined): string => {
    if (raw == null) return '';
    const v = raw.trim();
    const call = v.match(/^var\(\s*--([\w-]+)\s*(?:,\s*([^)]*))?\)$/);
    if (!call) return v;
    const [, ref, fallback] = call;
    if (map.has(ref) && !seen.has(ref)) {
      seen.add(ref);
      return resolve(map.get(ref));
    }
    return resolve(fallback);
  };
  return resolve(map.get(name));
}

// Forma's rules consume --radius-md (8×); Aura's consume --r (7×). rootVars emits --radius, so each
// theme must bridge --radius into its own primitive or the knob is a silent no-op (it was, before).
test('radius knob flows into Forma (--radius-md) and stays byte-identical by default', () => {
  const base = STOREFRONT_BASE_CSS;
  assert.equal(resolveVar(base + tokenCss({}), 'radius-md'), '12px', 'default corner unchanged');
  assert.equal(
    resolveVar(base + tokenCss({ radius: 'rounded' }), 'radius-md'),
    '18px',
    'rounded reaches the var Forma rules consume'
  );
  assert.equal(resolveVar(base + tokenCss({ radius: 'square' }), 'radius-md'), '0px');
});

test('radius knob flows into Aura (--r) and stays byte-identical by default', () => {
  const base = AURA_THEME_FILES['assets/base.css'];
  assert.equal(resolveVar(base + tokenCss({}), 'r'), '20px', 'default corner unchanged');
  assert.equal(
    resolveVar(base + tokenCss({ radius: 'rounded' }), 'r'),
    '18px',
    'rounded reaches the var Aura rules consume'
  );
});
