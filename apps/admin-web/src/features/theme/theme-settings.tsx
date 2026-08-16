// Theme Settings: the store's global style knobs (brand colour + typography + layout), with a live
// preview of the REAL storefront (the draft rendered through previewBundle → renderThemePreview, the
// same path the origin serves). Every option except the brand colour is a fixed scale (values mirror
// the backend @ratio/builder-core scales), so a merchant can't produce a broken or off-brand result.
// Saving purges the storefront (the theme is baked into every cached page).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Api, Store, StoreTheme, ThemeFiles } from '../../common/api';
import { ApiError, canManageStore } from '../../common/api';
import { Spinner, useToast } from '../../common/ui';
import { tokensFromFiles, filesWithTokens } from './tokens-file';
import './theme-settings.css';

// CSS values per token value — mirror packages/builder-core/src/storefront.ts so the preview matches
// what the origin actually renders.
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
// Human labels for the save-bar change summary, in the order they appear in the panel. Heading and
// body font move together (one typeface), so only the body font drives the "font" line.
const CHANGE_LABELS: Partial<Record<keyof StoreTheme, string>> = {
  color: 'brand colour',
  bodyFont: 'font',
  baseSize: 'base text size',
  radius: 'corner roundness',
};
const CHANGE_ORDER = Object.keys(CHANGE_LABELS) as (keyof StoreTheme)[];

const BRAND_SWATCHES = ['#3F53FE', '#131927', '#E88B00', '#217005', '#1A2C44'];

const DEFAULTS: Required<StoreTheme> = {
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

const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

// WCAG relative luminance + contrast ratio of a colour on white.
function contrastOnWhite(hex: string): number {
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
function resolve(t: StoreTheme): Required<StoreTheme> {
  return {
    color: t.color || DEFAULTS.color,
    headingFont: t.headingFont || DEFAULTS.headingFont,
    bodyFont: t.bodyFont || DEFAULTS.bodyFont,
    baseSize: t.baseSize || DEFAULTS.baseSize,
    radius: t.radius || DEFAULTS.radius,
    container: t.container || DEFAULTS.container,
  };
}

/* ── controls ─────────────────────────────────────────────────────────────── */

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

/* ── panel ─────────────────────────────────────────────────────────────────── */

export function ThemeSettingsPanel({
  api,
  store,
  themeId,
}: {
  api: Api;
  store: Store;
  themeId: string;
}) {
  const toast = useToast();
  const owner = canManageStore(store);
  const [theme, setTheme] = useState<StoreTheme | null>(null);
  const [saved, setSaved] = useState<StoreTheme | null>(null);
  // The theme's whole draft (base ⊕ overrides) + its revision. Brand tokens live INSIDE it as
  // config/tokens.json, so a save round-trips the current files (preserving the merchant's Liquid)
  // with only the tokens file rewritten, under optimistic concurrency (revision).
  const [files, setFiles] = useState<ThemeFiles | null>(null);
  const [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const [mobile, setMobile] = useState(false);

  const err = useCallback(
    (e: unknown, fallback: string) => toast(e instanceof ApiError ? e.message : fallback, 'error'),
    [toast]
  );

  const load = useCallback(async () => {
    try {
      const d = await api.getBundleDraft(store.id, themeId);
      setFiles(d.files);
      setRevision(d.revision);
      const t = tokensFromFiles(d.files);
      setTheme(t);
      setSaved(t);
    } catch (e) {
      err(e, 'Failed to load theme');
    }
  }, [api, store.id, themeId, err]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live preview of the REAL storefront: render the draft with the in-flight tokens through the same
  // path the origin serves (previewBundle → renderThemePreview), debounced so dragging the colour
  // picker doesn't hammer it. A transient failure keeps the last good frame rather than blocking.
  const [previewHtml, setPreviewHtml] = useState('');
  const previewTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!files || !theme) return;
    const draft = filesWithTokens(files, resolve(theme));
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      api
        .previewBundle(store.id, themeId, draft, 'index')
        .then((res) => setPreviewHtml(res.html ?? ''))
        .catch(() => {
          /* a transient preview render failure shouldn't block editing */
        });
    }, 300);
    return () => clearTimeout(previewTimer.current);
  }, [api, store.id, themeId, files, theme]);

  function set<K extends keyof StoreTheme>(key: K, value: StoreTheme[K]) {
    setTheme((t) => ({ ...(t ?? {}), [key]: value }));
  }
  // One typeface for the whole storefront: heading and body font stay in sync.
  function setFont(v: string) {
    setTheme((t) => ({ ...(t ?? {}), headingFont: v, bodyFont: v }));
  }
  function applyPreset(p: Preset) {
    // Content width has no control, so a preset must not change it — keep whatever the theme already
    // has, otherwise the width would shift silently with nothing in the change summary.
    setTheme((t) => ({ ...p.theme, container: t?.container ?? p.theme.container }));
  }

  const changes = useMemo(() => {
    if (!theme || !saved) return [] as (keyof StoreTheme)[];
    const a = resolve(theme);
    const b = resolve(saved);
    return CHANGE_ORDER.filter((k) => a[k] !== b[k]);
  }, [theme, saved]);
  const dirty = changes.length > 0;

  // Save the tokens into the theme's draft. Owners then publish so the change is live immediately (the
  // brand-settings expectation); a member can only save to the draft for an owner to publish. Both
  // write the SAME draft the code editor uses — one theme, one draft, one publish.
  async function save() {
    if (!theme || !files) return;
    setBusy(true);
    try {
      const next = filesWithTokens(files, theme);
      const res = await api.saveBundleDraft(store.id, themeId, next, revision);
      setFiles(next);
      setRevision(res.hash);
      setSaved(theme);
      if (owner) {
        await api.publishBundle(store.id, themeId);
        toast('Theme published — live now', 'ok');
      } else {
        toast('Saved to draft — an owner can publish it', 'ok');
      }
    } catch (e) {
      // The draft moved since we loaded it (another editor, or a code edit) → 409. Refresh files +
      // revision but KEEP the in-progress token edits so a retry re-applies them cleanly.
      if (e instanceof ApiError && e.status === 409) {
        try {
          const d = await api.getBundleDraft(store.id, themeId);
          setFiles(d.files);
          setRevision(d.revision);
        } catch {
          /* fall through to the toast */
        }
        toast('This theme changed elsewhere — review and save again', 'error');
      } else {
        err(e, 'Save failed');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!theme) {
    return (
      <div className="center-pad">
        <Spinner />
      </div>
    );
  }

  const r = resolve(theme);
  const ratio = isHex(r.color) ? contrastOnWhite(r.color) : null;
  const activePreset = PRESETS.find((p) => JSON.stringify(p.theme) === JSON.stringify(r));

  return (
    <div className="ts">
      <div className="ts-grid">
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
            <p className="muted ts-desc">Sets buttons, links and accents across the storefront.</p>
            <div className="ts-field-label">Brand colour</div>
            <div className="ts-brand">
              {BRAND_SWATCHES.map((c) => (
                <button
                  key={c}
                  className={
                    r.color.toLowerCase() === c.toLowerCase() ? 'ts-swatch on' : 'ts-swatch'
                  }
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
            <p className="muted ts-desc">Each option previews in its own typeface.</p>
            <div className="ts-field-label">Font</div>
            <FontPicker value={r.bodyFont} onChange={setFont} />
            <FieldHead
              label="Base text size"
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
              label="Corner roundness"
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
        </div>

        <div className="ts-preview">
          <div className="ts-preview-bar">
            <span className="ts-label" style={{ flex: 1 }}>
              {dirty ? 'Showing your changes' : 'Live preview'}
            </span>
            <div className="seg ts-seg">
              <button className={!mobile ? 'on' : ''} onClick={() => setMobile(false)}>
                Desktop
              </button>
              <button className={mobile ? 'on' : ''} onClick={() => setMobile(true)}>
                Mobile
              </button>
            </div>
          </div>
          <div className={mobile ? 'ts-frame-wrap mobile' : 'ts-frame-wrap'}>
            {previewHtml ? (
              <iframe
                className="ts-frame"
                sandbox=""
                srcDoc={previewHtml}
                title="Storefront preview"
              />
            ) : (
              <div className="ts-frame center-pad">
                <Spinner />
              </div>
            )}
          </div>
          <p className="muted ts-preview-note">
            {owner
              ? 'Preview only — nothing changes on the storefront until you save & publish.'
              : 'Preview only — your changes go live when an owner publishes the theme.'}
          </p>
        </div>
      </div>

      {dirty && (
        <div className="ts-savebar">
          <span className="ts-status warn">
            {`${changes.length} change${changes.length > 1 ? 's' : ''}: ${changes
              .map((k) => CHANGE_LABELS[k])
              .join(', ')}`}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setTheme(saved)} disabled={busy}>
            Discard
          </button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
            {owner ? 'Save & publish' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}
