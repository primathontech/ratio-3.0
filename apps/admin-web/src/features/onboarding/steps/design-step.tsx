import { useEffect, useMemo, useRef, useState } from 'react';
import { Field, Spinner } from '../../../common/ui';
import { ApiError, type StoreTheme, type ThemeFiles } from '../../../common/api';
import { tokensFromFiles, filesWithTokens } from '../../theme/tokens-file';
import { settingsFromFiles } from '../../theme/settings-file';
import { ThemeControls, resolve } from '../../theme/theme-controls';
import { PreviewFrame } from '../../theme/preview-frame';
import { readFeatured, mapFeaturedCollections } from '../featured';
import type { StepProps } from '../types';

// Step 3 — design (Phase C). The SAME theme controls the Settings panel uses (presets + brand +
// typography + layout, via <ThemeControls>) plus the merchant's REAL collections mapped into the
// featured home rows, all against a LIVE preview of their real store. Edits the theme draft
// (config/tokens.json + templates/index.json); the Launch step publishes it.
export function DesignStep({ api, data, patch, onNext, onBack }: StepProps) {
  const [files, setFiles] = useState<ThemeFiles | null>(null);
  const [revision, setRevision] = useState('');
  const [collections, setCollections] = useState<{ handle: string; title: string }[]>([]);
  const [tokens, setTokens] = useState<StoreTheme>({ color: data.color });
  const [newArrivals, setNewArrivals] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [mobile, setMobile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storeId = data.storeId;
  const themeId = data.themeId;

  useEffect(() => {
    if (!storeId || !themeId) return;
    Promise.all([
      api.getBundleDraft(storeId, themeId),
      api.listCollections(storeId).catch(() => []),
    ])
      .then(([draft, cols]) => {
        setFiles(draft.files);
        setRevision(draft.revision);
        // The theme's own tokens win; fall back to the colour chosen in step 2 when the theme omits it.
        setTokens({ color: data.color, ...tokensFromFiles(draft.files) });
        // Preselect the row's saved collection, else the first available one so the picker always
        // shows a real choice. With no collections at all, it stays empty → the row falls back to the
        // all-products listing (see mapFeaturedCollections).
        setNewArrivals(readFeatured(draft.files).newArrivals || cols[0]?.handle || '');
        setCollections(cols);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the theme'));
  }, [api, storeId, themeId, data.color]);

  // The draft with the in-flight design applied — both what we preview and what we save.
  const draft = useMemo(() => {
    if (!files) return null;
    const withTokens = filesWithTokens(files, resolve(tokens));
    return mapFeaturedCollections(withTokens, { newArrivals });
  }, [files, tokens, newArrivals]);

  // The theme's own controls (from its config/settings.json in the loaded draft).
  const settings = useMemo(() => (files ? settingsFromFiles(files) : []), [files]);

  // Live preview, debounced so dragging the colour picker doesn't hammer the render.
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!draft || !storeId || !themeId) return;
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      api
        .previewBundle(storeId, themeId, draft, 'index')
        .then((r) => setPreviewHtml(r.html ?? ''))
        .catch(() => {
          /* a transient preview failure shouldn't block the step */
        });
    }, 300);
    return () => clearTimeout(previewTimer.current);
  }, [api, storeId, themeId, draft]);

  async function saveAndNext() {
    if (!draft || !storeId || !themeId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.saveBundleDraft(storeId, themeId, draft, revision);
      setFiles(draft);
      setRevision(res.hash);
      patch({ color: resolve(tokens).color });
      onNext();
    } catch (e) {
      // The draft moved since we loaded it (rare in a fresh single-editor wizard) → refresh files +
      // revision so a retry saves cleanly, keeping the in-progress design selections.
      if (e instanceof ApiError && e.status === 409) {
        try {
          const d = await api.getBundleDraft(storeId, themeId);
          setFiles(d.files);
          setRevision(d.revision);
        } catch {
          /* fall through to the message */
        }
        setError('This store changed elsewhere — review and continue again.');
      } else {
        setError(e instanceof ApiError ? e.message : 'Could not save your design');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!files) {
    return (
      <div className="ob-card">
        <div className="center-pad">
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <div className="ob-card ob-card-wide">
      <h1 className="ob-title">Design your store</h1>
      <p className="ob-lede">
        Pick a look and choose which collections to feature. The preview shows your real store as
        you go.
      </p>

      <div className="ts">
        <div className="ts-grid">
          <ThemeControls theme={tokens} onChange={setTokens} settings={settings}>
            <section>
              <div className="ts-label ds-section-label">Homepage Products</div>
              {collections.length > 0 ? (
                <Field
                  label="Show"
                  info="Choose which collection's products to show on your homepage."
                >
                  <CollectionSelect
                    value={newArrivals}
                    options={collections}
                    onChange={setNewArrivals}
                  />
                </Field>
              ) : (
                <p className="muted ts-desc">
                  Connect a catalogue to feature a collection — the row shows all products until
                  then.
                </p>
              )}
            </section>
          </ThemeControls>

          <div className="ts-preview">
            <div className="ts-preview-bar">
              <span className="ts-label" style={{ flex: 1 }}>
                Live preview
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
                <PreviewFrame className="ts-frame" title="Store preview" html={previewHtml} />
              ) : (
                <div className="ts-frame center-pad">
                  <Spinner />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="note note-error" role="alert">
          {error}
        </div>
      )}
      <div className="ob-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={saveAndNext} disabled={busy}>
          {busy ? <Spinner /> : 'Continue'}
        </button>
      </div>
    </div>
  );
}

function CollectionSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { handle: string; title: string }[];
  onChange: (v: string) => void;
}) {
  // A handle the store no longer has (e.g. one saved earlier, or the theme default) still shows so the
  // row isn't silently repointed; picking a real collection replaces it.
  const known = options.some((o) => o.handle === value);
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {value && !known && <option value={value}>{value} (Not in your catalogue)</option>}
      {options.map((o) => (
        <option key={o.handle} value={o.handle}>
          {o.title}
        </option>
      ))}
    </select>
  );
}
