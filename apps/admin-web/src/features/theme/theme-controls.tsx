// Shared theme design controls: Start-from presets + Brand colour + Typography + Layout. Presentational
// and fully controlled (theme in, onChange out), so both the Theme Settings panel and the onboarding
// Design step render the SAME UI — each supplies its own live preview + save affordance (Publish vs
// Continue). A `children` slot lets a caller append extra controls (onboarding adds the featured-
// collection pickers). Every option except brand colour is a fixed scale mirroring the backend
// @ratio/builder-core scales, so a merchant can't produce a broken or off-brand result.
import type { ReactNode } from 'react';
import type { StoreTheme } from '../../common/api';
import './theme-settings.css';

// CSS values per token value — mirror packages/builder-core/src/storefront.ts so previews match render.
const FONT_STACK: Record<string, string> = {
  system: `system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`,
  sans: `'Helvetica Neue',Arial,sans-serif`,
  serif: `Georgia,'Times New Roman',serif`,
  rounded: `'Trebuchet MS','Segoe UI',system-ui,sans-serif`,
  mono: `ui-monospace,'SF Mono',Menlo,monospace`,
};
const FONT_LABEL: Record<string, string> = {
  system: 'System',
  sans: 'Sans',
  serif: 'Serif',
  rounded: 'Rounded',
  mono: 'Mono',
};
const FONT_ORDER = ['system', 'sans', 'serif', 'rounded', 'mono'];
const SIZE_PX: Record<string, number> = { s: 15, m: 16, l: 18 };
const SIZE_LABEL: Record<string, string> = { s: 'Small', m: 'Default', l: 'Large' };
const RADIUS_PX: Record<string, number> = { square: 0, soft: 10, rounded: 18 };
const RADIUS_LABEL: Record<string, string> = { square: 'Square', soft: 'Soft', rounded: 'Rounded' };
// Each corner option previews its own shape, so the choice reads at a glance.
const CORNER_ICON: Record<string, ReactNode> = {
  square: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="0" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  soft: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="3.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  rounded: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
};

const BRAND_SWATCHES = ['#3F53FE', '#131927', '#E88B00', '#217005', '#1A2C44'];

export const DEFAULTS: Required<StoreTheme> = {
  color: '#3F53FE',
  headingFont: 'sans',
  bodyFont: 'sans',
  baseSize: 'm',
  radius: 'soft',
  container: 'normal',
};

type Preset = { id: string; name: string; theme: Required<StoreTheme>; desc: string };
const PRESETS: Preset[] = [
  {
    id: 'default',
    name: 'Default',
    theme: {
      color: '#3F53FE',
      headingFont: 'sans',
      bodyFont: 'sans',
      baseSize: 'm',
      radius: 'soft',
      container: 'normal',
    },
    desc: 'Sans · soft',
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
      container: 'normal',
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
      container: 'normal',
    },
    desc: 'Sans · round',
  },
];

export const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

// WCAG relative luminance + contrast ratio of a colour on white.
export function contrastOnWhite(hex: string): number {
  const c = hex.replace('#', '');
  const lin = [0, 2, 4]
    .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return 1.05 / (L + 0.05);
}
function contrastGrade(ratio: number): string {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA large only';
  return 'below AA';
}

// Resolve a (possibly partial) theme to concrete values for rendering.
export function resolve(t: StoreTheme): Required<StoreTheme> {
  return {
    color: t.color || DEFAULTS.color,
    headingFont: t.headingFont || DEFAULTS.headingFont,
    bodyFont: t.bodyFont || DEFAULTS.bodyFont,
    baseSize: t.baseSize || DEFAULTS.baseSize,
    radius: t.radius || DEFAULTS.radius,
    container: t.container || DEFAULTS.container,
  };
}

function Choice<T extends string>({
  options,
  value,
  labels,
  icons,
  onChange,
}: {
  options: T[];
  value: T;
  labels: Record<string, string>;
  icons?: Record<string, ReactNode>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="ts-choice-row">
      {options.map((o) => (
        <button
          key={o}
          className={value === o ? 'ts-choice on' : 'ts-choice'}
          aria-pressed={value === o}
          onClick={() => onChange(o)}
        >
          {icons?.[o]}
          <span>{labels[o]}</span>
        </button>
      ))}
    </div>
  );
}

function FieldHead({
  label,
  value,
  canReset,
  onReset,
}: {
  label: string;
  value: string;
  canReset: boolean;
  onReset: () => void;
}) {
  return (
    <div className="ts-field-head">
      <span className="ts-field-label">{label}</span>
      <span className="muted">{value}</span>
      {canReset && (
        <button className="ts-reset" onClick={onReset}>
          Reset
        </button>
      )}
    </div>
  );
}

function FontPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="ts-fonts">
      {FONT_ORDER.map((key) => (
        <button
          key={key}
          className={value === key ? 'ts-font on' : 'ts-font'}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          <span className="ts-font-ag" style={{ fontFamily: FONT_STACK[key] }}>
            Ag
          </span>
          <span className="muted ts-font-label">{FONT_LABEL[key]}</span>
        </button>
      ))}
    </div>
  );
}

// The controls column, controlled by `theme`/`onChange`. `children` renders after the built-in
// sections (onboarding drops the featured-collection pickers there).
export function ThemeControls({
  theme,
  onChange,
  children,
}: {
  theme: StoreTheme;
  onChange: (next: StoreTheme) => void;
  children?: ReactNode;
}) {
  const r = resolve(theme);
  const ratio = isHex(r.color) ? contrastOnWhite(r.color) : null;
  const activePreset = PRESETS.find((p) => JSON.stringify(p.theme) === JSON.stringify(r));
  const set = <K extends keyof StoreTheme>(key: K, value: StoreTheme[K]) =>
    onChange({ ...theme, [key]: value });
  // One typeface for the whole storefront: heading and body font stay in sync.
  const setFont = (v: string) => onChange({ ...theme, headingFont: v, bodyFont: v });
  // A preset must not change content width (no control for it) — keep whatever the theme has.
  const applyPreset = (p: Preset) =>
    onChange({ ...p.theme, container: theme.container ?? p.theme.container });

  return (
    <div className="ts-controls">
      <section>
        <div className="ts-label">Start from</div>
        <div className="ts-presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={activePreset?.id === p.id ? 'ts-preset on' : 'ts-preset'}
              aria-pressed={activePreset?.id === p.id}
              onClick={() => applyPreset(p)}
            >
              <span className="ts-preset-head">
                <span className="ts-preset-dot" style={{ background: p.theme.color }} />
                <strong>{p.name}</strong>
              </span>
              <span className="muted ts-preset-desc">{p.desc}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="ts-label">Brand</div>
        <div className="ts-field-label">Brand colour</div>
        <div className="ts-brand">
          {BRAND_SWATCHES.map((c) => (
            <button
              key={c}
              className={r.color.toLowerCase() === c.toLowerCase() ? 'ts-swatch on' : 'ts-swatch'}
              aria-pressed={r.color.toLowerCase() === c.toLowerCase()}
              style={{ background: c }}
              aria-label={c}
              onClick={() => set('color', c)}
            />
          ))}
          <span className="ts-brand-divider" />
          <div className="ts-hex">
            <span
              className="ts-hex-chip"
              style={{ background: isHex(r.color) ? r.color : 'var(--surface-2)' }}
            />
            <input
              value={r.color}
              onChange={(e) => set('color', e.target.value)}
              aria-label="Brand colour hex"
            />
          </div>
        </div>
        {ratio !== null && (
          <div className={`ts-contrast ${ratio < 4.5 ? 'warn' : ''}`}>
            {ratio.toFixed(2)}:1 on white · {contrastGrade(ratio)}
          </div>
        )}
      </section>

      <section>
        <div className="ts-label">Typography</div>
        <div className="ts-field-label">Font Family</div>
        <FontPicker value={r.bodyFont} onChange={setFont} />
        <FieldHead
          label="Font Size"
          value={`${SIZE_PX[r.baseSize]}px`}
          canReset={r.baseSize !== DEFAULTS.baseSize}
          onReset={() => set('baseSize', DEFAULTS.baseSize)}
        />
        <Choice
          options={['s', 'm', 'l']}
          value={r.baseSize}
          labels={SIZE_LABEL}
          onChange={(v) => set('baseSize', v)}
        />
      </section>

      <section>
        <div className="ts-label">Layout</div>
        <FieldHead
          label="Radius"
          value={`${RADIUS_PX[r.radius]}px`}
          canReset={r.radius !== DEFAULTS.radius}
          onReset={() => set('radius', DEFAULTS.radius)}
        />
        <Choice
          options={['square', 'soft', 'rounded']}
          value={r.radius}
          labels={RADIUS_LABEL}
          icons={CORNER_ICON}
          onChange={(v) => set('radius', v)}
        />
      </section>

      {children}
    </div>
  );
}
