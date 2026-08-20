// Shared theme design controls: Start-from presets + Brand colour + Typography + Layout. Presentational
// and fully controlled (theme in, onChange out), so both the Theme Settings panel and the onboarding
// Design step render the SAME UI — each supplies its own live preview + save affordance (Publish vs
// Continue). A `children` slot lets a caller append extra controls (onboarding adds the featured-
// collection pickers). Every option except brand colour is a fixed scale mirroring the backend
// @ratio/builder-core scales, so a merchant can't produce a broken or off-brand result.
import type { ReactNode } from 'react';
import type { StoreTheme } from '../../common/api';
import {
  FONTS,
  FONT_LABELS,
  FONT_ORDER,
  BASE_SIZE,
  SIZE_LABELS,
  BRAND_SWATCHES,
  THEME_DEFAULTS,
  THEME_PRESETS,
  type ThemePreset,
  type ThemeSettingControl,
} from '@ratio/design-tokens';
import './theme-settings.css';

// The token vocabulary + fixed scales come from @ratio/design-tokens — the single source shared with
// the storefront renderer, so a preview here can't drift from what the backend actually renders. Only
// the corner-shape icons (JSX, editor-only) live locally.
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

// Must match the default bundle theme so a fresh store reads as the "Default" preset — sourced from the
// shared token package (the same defaults the backend ships), so it can never drift.
export const DEFAULTS: Required<StoreTheme> = THEME_DEFAULTS;

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
    elevation: t.elevation || DEFAULTS.elevation,
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
          <span className="ts-font-ag" style={{ fontFamily: FONTS[key] }}>
            Ag
          </span>
          <span className="muted ts-font-label">{FONT_LABELS[key]}</span>
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
  settings = [],
  children,
}: {
  theme: StoreTheme;
  onChange: (next: StoreTheme) => void;
  // The active theme's own controls (from its config/settings.json). Global knobs above always show;
  // these theme-owned controls render only where the theme declares them, so nothing is ever inert.
  settings?: ThemeSettingControl[];
  children?: ReactNode;
}) {
  const r = resolve(theme);
  const ratio = isHex(r.color) ? contrastOnWhite(r.color) : null;
  const activePreset = THEME_PRESETS.find((p) => JSON.stringify(p.theme) === JSON.stringify(r));
  const set = <K extends keyof StoreTheme>(key: K, value: StoreTheme[K]) =>
    onChange({ ...theme, [key]: value });
  // One typeface for the whole storefront: heading and body font stay in sync.
  const setFont = (v: string) => onChange({ ...theme, headingFont: v, bodyFont: v });
  // A preset must not change content width (no control for it) — keep whatever the theme has.
  const applyPreset = (p: ThemePreset) =>
    onChange({ ...p.theme, container: theme.container ?? p.theme.container });

  return (
    <div className="ts-controls">
      <section>
        <div className="ts-label">Start from</div>
        <div className="ts-presets">
          {THEME_PRESETS.map((p) => (
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
          value={BASE_SIZE[r.baseSize]}
          canReset={r.baseSize !== DEFAULTS.baseSize}
          onReset={() => set('baseSize', DEFAULTS.baseSize)}
        />
        <Choice
          options={['s', 'm', 'l']}
          value={r.baseSize}
          labels={SIZE_LABELS}
          onChange={(v) => set('baseSize', v)}
        />
      </section>

      {settings.length > 0 && (
        <section>
          <div className="ts-label">Theme options</div>
          {settings.map((ctrl) => {
            const key = ctrl.id as keyof StoreTheme;
            const value = theme[key] || ctrl.default;
            const labels = Object.fromEntries(ctrl.options.map((o) => [o.value, o.label]));
            const options = ctrl.options.map((o) => o.value);
            return (
              <div key={ctrl.id}>
                <FieldHead
                  label={ctrl.label}
                  value={labels[value] ?? value}
                  canReset={value !== ctrl.default}
                  onReset={() => set(key, ctrl.default)}
                />
                <Choice
                  options={options}
                  value={value}
                  labels={labels}
                  icons={ctrl.id === 'radius' ? CORNER_ICON : undefined}
                  onChange={(v) => set(key, v)}
                />
              </div>
            );
          })}
        </section>
      )}

      {children}
    </div>
  );
}
