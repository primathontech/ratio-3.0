// Theme Settings: the store's global style knobs (brand colour + a few scale-picked choices).
// Every option except the brand colour is a fixed scale, so a merchant can't produce an off-brand
// or broken result. Saving purges the storefront (theme is baked into every cached page).
import { useCallback, useEffect, useState } from 'react';
import type { Api, Store, StoreTheme } from './api';
import { ApiError } from './api';
import { Spinner, useToast } from './ui';

const FONT_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'sans', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'mono', label: 'Mono' },
];
const SIZE_OPTIONS = [
  { value: 's', label: 'Small' },
  { value: 'm', label: 'Medium' },
  { value: 'l', label: 'Large' },
];
const RADIUS_OPTIONS = [
  { value: 'square', label: 'Square' },
  { value: 'soft', label: 'Soft' },
  { value: 'rounded', label: 'Rounded' },
];
const CONTAINER_OPTIONS = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
];

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (v: string | undefined) => void;
}) {
  return (
    <label className="field" style={{ display: 'block', marginBottom: 10 }}>
      <span className="muted" style={{ fontSize: 12 }}>
        {label}
      </span>
      <select
        className="input"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">Default</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ThemeSettingsPanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [theme, setTheme] = useState<StoreTheme | null>(null);
  const [busy, setBusy] = useState(false);

  const err = useCallback(
    (e: unknown, fallback: string) => toast(e instanceof ApiError ? e.message : fallback, 'error'),
    [toast]
  );

  useEffect(() => {
    api
      .getTheme(store.id)
      .then(setTheme)
      .catch((e) => err(e, 'Failed to load theme'));
  }, [api, store.id, err]);

  function set<K extends keyof StoreTheme>(key: K, value: StoreTheme[K]) {
    setTheme((t) => ({ ...(t ?? {}), [key]: value }));
  }

  async function save() {
    if (!theme) return;
    setBusy(true);
    try {
      const saved = await api.saveTheme(store.id, theme);
      setTheme(saved.theme);
      toast('Theme saved', 'ok');
      if (saved.edgePurged === false)
        toast('Saved, but the edge cache purge failed — it may serve stale briefly', 'error');
    } catch (e) {
      err(e, 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card pane" style={{ marginBottom: 18 }}>
      <div className="pane-head">
        <h2>Theme settings</h2>
      </div>
      {!theme ? (
        <div className="center-pad">
          <Spinner />
        </div>
      ) : (
        <>
          <label className="field" style={{ display: 'block', marginBottom: 10 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              Brand colour
            </span>
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <input
                type="color"
                value={theme.color || '#2563eb'}
                onChange={(e) => set('color', e.target.value)}
                aria-label="Brand colour"
              />
              <span className="mono" style={{ fontSize: 13 }}>
                {theme.color || '#2563eb'}
              </span>
            </div>
          </label>
          <Select
            label="Body font"
            value={theme.bodyFont}
            options={FONT_OPTIONS}
            onChange={(v) => set('bodyFont', v)}
          />
          <Select
            label="Heading font"
            value={theme.headingFont}
            options={FONT_OPTIONS}
            onChange={(v) => set('headingFont', v)}
          />
          <Select
            label="Base text size"
            value={theme.baseSize}
            options={SIZE_OPTIONS}
            onChange={(v) => set('baseSize', v)}
          />
          <Select
            label="Corner roundness"
            value={theme.radius}
            options={RADIUS_OPTIONS}
            onChange={(v) => set('radius', v)}
          />
          <Select
            label="Content width"
            value={theme.container}
            options={CONTAINER_OPTIONS}
            onChange={(v) => set('container', v)}
          />
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              Save theme
            </button>
          </div>
        </>
      )}
    </div>
  );
}
