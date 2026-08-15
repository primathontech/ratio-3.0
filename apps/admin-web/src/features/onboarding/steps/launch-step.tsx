import { useState } from 'react';
import { Spinner } from '../../../common/ui';
import { ApiError, type Api } from '../../../common/api';
import { liveStoreUrl } from '../host';
import type { WizardData } from '../types';

// Step 4 — review + launch. Publishing the store's theme is what makes it live (a draft store has
// live_theme_id NULL until now). Shows a success screen with the live URL on completion.
export function LaunchStep({
  api,
  data,
  isLocal,
  onBack,
  onDone,
}: {
  api: Api;
  data: WizardData;
  isLocal: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);

  async function launch() {
    if (!data.storeId || !data.themeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.publishBundle(data.storeId, data.themeId);
      setLaunched(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not launch your store');
    } finally {
      setBusy(false);
    }
  }

  if (launched) {
    return (
      <div className="ob-card ob-success">
        <div className="ob-success-emoji" aria-hidden="true">
          🎉
        </div>
        <h1 className="ob-title">{data.name} is live</h1>
        <p className="ob-lede">Your storefront is published and ready for shoppers.</p>
        <div className="ob-actions ob-actions-center">
          <a
            className="btn btn-ghost"
            href={liveStoreUrl(data.host, data.storeUrl, isLocal)}
            target="_blank"
            rel="noreferrer"
          >
            View store ↗
          </a>
          <button type="button" className="btn btn-primary" onClick={onDone}>
            Go to dashboard
          </button>
        </div>
      </div>
    );
  }

  const commerce = data.skipCommerce ? 'Set up later' : data.merchantId.trim() || '—';
  return (
    <div className="ob-card">
      <h1 className="ob-title">Ready to launch</h1>
      <p className="ob-lede">Review your store, then publish it live.</p>
      <dl className="ob-review">
        <div>
          <dt>Store</dt>
          <dd>{data.name}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd className="mono">{data.host}</dd>
        </div>
        <div>
          <dt>Commerce</dt>
          <dd className="mono">{commerce}</dd>
        </div>
        <div>
          <dt>Brand colour</dt>
          <dd>
            <span className="ob-swatch" style={{ background: data.color }} /> {data.color}
          </dd>
        </div>
      </dl>
      {error && (
        <div className="note note-error" role="alert">
          {error}
        </div>
      )}
      <div className="ob-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={launch} disabled={busy}>
          {busy ? <Spinner /> : 'Launch store'}
        </button>
      </div>
    </div>
  );
}
