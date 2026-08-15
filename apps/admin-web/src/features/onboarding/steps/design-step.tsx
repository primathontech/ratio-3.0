import { useEffect, useMemo, useRef, useState } from 'react';
import { Field, Spinner } from '../../../common/ui';
import { ApiError, type ThemeFiles } from '../../../common/api';
import { tokensFromFiles, filesWithTokens } from '../../theme/tokens-file';
import { readFeatured, mapFeaturedCollections } from '../featured';
import type { StepProps } from '../types';

// Fixed scales, mirroring packages/builder-core/src/storefront.ts so the wizard can't produce an
// off-scale (broken) theme. (The Settings panel keeps richer controls; onboarding stays lean.)
const FONTS: [string, string][] = [
  ['system', 'System'],
  ['sans', 'Sans'],
  ['serif', 'Serif'],
  ['rounded', 'Rounded'],
  ['mono', 'Mono'],
];
const CORNERS: [string, string][] = [
  ['square', 'Square'],
  ['soft', 'Soft'],
  ['rounded', 'Rounded'],
];

// Step 3 — design (Phase C). Full brand controls (colour / font / corners) + mapping the merchant's
// REAL collections into the theme's featured home rows, all against a LIVE preview rendered from the
// draft with their real products. Edits the theme draft (config/tokens.json + templates/index.json)
// and the Launch step publishes it.
export function DesignStep({ api, data, patch, onNext, onBack }: StepProps) {
  const [files, setFiles] = useState<ThemeFiles | null>(null);
  const [revision, setRevision] = useState('');
  const [collections, setCollections] = useState<{ handle: string; title: string }[]>([]);
  const [color, setColor] = useState(data.color);
  const [font, setFont] = useState('sans');
  const [corners, setCorners] = useState('soft');
  const [newArrivals, setNewArrivals] = useState('');
  const [trending, setTrending] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
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
        const t = tokensFromFiles(draft.files);
        if (t.color) setColor(t.color);
        if (t.bodyFont) setFont(t.bodyFont);
        if (t.radius) setCorners(t.radius);
        const f = readFeatured(draft.files);
        setNewArrivals(f.newArrivals);
        setTrending(f.trending);
        setCollections(cols);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the theme'));
  }, [api, storeId, themeId]);

  // The draft with the in-flight design applied — both what we preview and what we save.
  const draft = useMemo(() => {
    if (!files) return null;
    const withTokens = filesWithTokens(files, {
      ...tokensFromFiles(files),
      color,
      bodyFont: font,
      headingFont: font,
      radius: corners,
    });
    return mapFeaturedCollections(withTokens, { newArrivals, trending });
  }, [files, color, font, corners, newArrivals, trending]);

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
    }, 400);
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
      patch({ color });
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
        Set your brand and choose which collections to feature. The preview shows your real store as
        you go.
      </p>

      <div className="ob-design">
        <div className="ob-design-controls">
          <Field label="Brand colour">
            <input
              className="input"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{ height: 42, padding: 4, maxWidth: 120 }}
            />
          </Field>
          <Field label="Font">
            <select className="input" value={font} onChange={(e) => setFont(e.target.value)}>
              {FONTS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Corners">
            <select className="input" value={corners} onChange={(e) => setCorners(e.target.value)}>
              {CORNERS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>

          {collections.length > 0 ? (
            <>
              <Field label="New arrivals row" info="Which collection this featured row shows.">
                <CollectionSelect
                  value={newArrivals}
                  options={collections}
                  onChange={setNewArrivals}
                />
              </Field>
              <Field label="Trending row">
                <CollectionSelect value={trending} options={collections} onChange={setTrending} />
              </Field>
            </>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>
              Connect a catalogue to feature your collections — the theme's rows fill in once
              products are available.
            </p>
          )}
        </div>

        <div className="ob-design-preview">
          {previewHtml ? (
            <iframe
              className="ob-preview-frame"
              sandbox=""
              srcDoc={previewHtml}
              title="Store preview"
            />
          ) : (
            <div className="ob-preview-frame center-pad">
              <Spinner />
            </div>
          )}
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
