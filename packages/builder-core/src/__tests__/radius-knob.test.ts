import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOREFRONT_BASE_CSS, tokenCss } from '../storefront/storefront';
import { AURA_THEME_FILES } from '../theme/library/aura-theme.generated';
import { ATELIER_THEME_FILES } from '../theme/library/atelier-theme.generated';
import { NOVA_THEME_FILES } from '../theme/library/nova-theme.generated';

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

// Card-elevation is a theme-owned knob: Forma's .card rests on `var(--elevation, none)`. rootVars only
// emits --elevation when the merchant chooses one, so cards stay flat by default (byte-identical).
test('card-elevation knob flows into Forma (--elevation) and stays flat by default', () => {
  const base = STOREFRONT_BASE_CSS;
  assert.ok(
    base.includes('var(--elevation'),
    'Forma cards consume --elevation (the bridge exists)'
  );
  assert.equal(
    resolveVar(base + tokenCss({}), 'elevation'),
    '',
    'no --elevation emitted by default'
  );
  assert.equal(
    resolveVar(base + tokenCss({ elevation: 'lifted' }), 'elevation'),
    resolveVar(base, 'shadow-md'),
    'lifted re-points --elevation to the theme shadow scale'
  );
  assert.equal(
    resolveVar(base + tokenCss({ elevation: 'soft' }), 'elevation'),
    resolveVar(base, 'shadow-sm'),
    'soft re-points to the smaller theme shadow'
  );
  assert.equal(resolveVar(base + tokenCss({ elevation: 'flat' }), 'elevation'), 'none');
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

// Nova and Atelier own their corner shape as part of the theme identity, so they must NOT read the
// merchant --radius knob at all (opt out by design, not via an unused token that could later collide).
for (const [name, files] of [
  ['Nova', NOVA_THEME_FILES],
  ['Atelier', ATELIER_THEME_FILES],
] as const) {
  test(`${name} opts out of the radius knob — never reads var(--radius)`, () => {
    assert.ok(
      !files['assets/base.css'].includes('var(--radius)'),
      `${name} must not consume the merchant --radius token`
    );
  });
}
