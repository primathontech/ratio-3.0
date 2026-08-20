// Theme Settings: the store's global style knobs (brand colour + typography + layout), with a live
// preview of the REAL storefront (the draft rendered through previewBundle → renderThemePreview, the
// same path the origin serves). Every option except the brand colour is a fixed scale (values mirror
// the backend @ratio/builder-core scales), so a merchant can't produce a broken or off-brand result.
// Saving purges the storefront (the theme is baked into every cached page).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Api, Store, StoreTheme, ThemeFiles } from '../../common/api';
import { ApiError, canManageStore } from '../../common/api';
import { Spinner, useToast } from '../../common/ui';
import { tokensFromFiles, filesWithTokens } from './tokens-file';
import { settingsFromFiles } from './settings-file';
import { PreviewFrame } from './preview-frame';
import { ThemeControls, resolve } from './theme-controls';
import './theme-settings.css';

// Human labels for the save-bar change summary, in the order they appear in the panel. Heading and
// body font move together (one typeface), so only the body font drives the "font" line.
const CHANGE_LABELS: Partial<Record<keyof StoreTheme, string>> = {
  color: 'brand colour',
  bodyFont: 'font',
  baseSize: 'base text size',
  radius: 'corner roundness',
  elevation: 'card elevation',
};
const CHANGE_ORDER = Object.keys(CHANGE_LABELS) as (keyof StoreTheme)[];

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
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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

  // The active theme's own controls (corners, card elevation …) come from its shipped config/settings.json,
  // already present in the loaded draft files — so the editor shows exactly the knobs this theme honours.
  const settings = useMemo(() => (files ? settingsFromFiles(files) : []), [files]);

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

  return (
    <div className="ts">
      <div className="ts-grid">
        <ThemeControls theme={theme} onChange={setTheme} settings={settings} />

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
              <PreviewFrame className="ts-frame" title="Storefront preview" html={previewHtml} />
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
