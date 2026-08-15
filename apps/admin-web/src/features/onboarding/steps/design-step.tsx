import { useEffect, useState } from 'react';
import { Field, Spinner } from '../../../common/ui';
import { ApiError, type ThemeFiles } from '../../../common/api';
import { tokensFromFiles, filesWithTokens } from '../../theme/tokens-file';
import type { StepProps } from '../types';

// Step 3 — design (Phase B: brand colour only). Edits the store's theme DRAFT (config/tokens.json),
// the same per-theme token flow the Settings panel uses; the Launch step publishes it. Collection
// mapping + a real-product live preview + the full brand controls land in Phase C.
export function DesignStep({ api, data, patch, onNext, onBack }: StepProps) {
  const [files, setFiles] = useState<ThemeFiles | null>(null);
  const [revision, setRevision] = useState('');
  const [color, setColor] = useState(data.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data.storeId || !data.themeId) return;
    api
      .getBundleDraft(data.storeId, data.themeId)
      .then((d) => {
        setFiles(d.files);
        setRevision(d.revision);
        const existing = tokensFromFiles(d.files).color;
        if (existing) setColor(existing);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the theme'));
  }, [api, data.storeId, data.themeId]);

  async function saveAndNext() {
    if (!files || !data.storeId || !data.themeId) return;
    setBusy(true);
    setError(null);
    try {
      const next = filesWithTokens(files, { ...tokensFromFiles(files), color });
      const res = await api.saveBundleDraft(data.storeId, data.themeId, next, revision);
      setFiles(next);
      setRevision(res.hash);
      patch({ color });
      onNext();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save your design');
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
    <div className="ob-card">
      <h1 className="ob-title">Make it yours</h1>
      <p className="ob-lede">
        Pick your brand colour — it sets buttons, links and accents across your storefront. You can
        fine-tune the full design any time after launch.
      </p>
      <Field label="Brand colour">
        <input
          className="input"
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          style={{ height: 42, padding: 4, maxWidth: 120 }}
        />
      </Field>
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
