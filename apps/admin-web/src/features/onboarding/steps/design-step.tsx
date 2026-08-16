import { useEffect, useMemo, useRef, useState } from 'react';
import { Field, Spinner } from '../../../common/ui';
import { ApiError, type StoreTheme, type ThemeFiles } from '../../../common/api';
import { tokensFromFiles, filesWithTokens } from '../../theme/tokens-file';
import { ThemeControls, resolve } from '../../theme/theme-controls';
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
  const [trending, setTrending] = useState('');
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
        const f = readFeatured(draft.files);
        setNewArrivals(f.newArrivals);
        setTrending(f.trending);
        setCollections(cols);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the theme'));
  }, [api, storeId, themeId, data.color]);

  // The draft with the in-flight design applied — both what we preview and what we save.
  const draft = useMemo(() => {
    if (!files) return null;
    const withTokens = filesWithTokens(files, resolve(tokens));
    return mapFeaturedCollections(withTokens, { newArrivals, trending });
  }, [files, tokens, newArrivals, trending]);

  // Live preview, debounced so dragging the colour picker doesn't hammer the render.
  const previewTimer = useRef<ReturnType<typeof setTimeout>>();
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
          <ThemeControls theme={tokens} onChange={setTokens}>
            <section>
              <div className="ts-label">Featured collections</div>
              {collections.length > 0 ? (
                <>
                  <Field label="New arrivals row" info="Which collection this featured row shows.">
                    <CollectionSelect
                      value={newArrivals}
                      options={collections}
                      onChange={setNewArrivals}
                    />
                  </Field>
                  <Field label="New launches row">
                    <CollectionSelect
                      value={trending}
                      options={collections}
                      onChange={setTrending}
                    />
                  </Field>
                </>
              ) : (
                <p className="muted ts-desc">
                  Connect a catalogue to feature your collections — the rows fill in once products
                  are available.
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
                <iframe
                  className="ts-frame"
                  sandbox=""
                  srcDoc={previewHtml}
                  title="Store preview"
                />
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
  // A handle the store no longer has (e.g. the theme's default) still shows so the row isn't silently
  // repointed; picking a real collection replaces it.
  const known = options.some((o) => o.handle === value);
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {/* Keep the shown selection and React state in sync: a placeholder for an empty value, or the
          current (non-catalogue) handle, so the browser never highlights an option state doesn't hold. */}
      {!value && (
        <option value="" disabled>
          Choose a collection…
        </option>
      )}
      {value && !known && <option value={value}>{value} (not in your catalogue)</option>}
      {options.map((o) => (
        <option key={o.handle} value={o.handle}>
          {o.title}
        </option>
      ))}
    </select>
  );
}
