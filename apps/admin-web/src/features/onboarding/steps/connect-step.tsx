import { useState } from 'react';
import { Field, Spinner } from '../../../common/ui';
import { ApiError } from '../../../common/api';
import type { StepProps } from '../types';

// Step 1 — the prerequisite: the merchant must already be onboarded on the commerce backend (they
// hold a merchant ID). We verify it against the backend so a typo can't launch a store that shows
// nothing. A merchant still building their catalogue can skip and connect later.
export function ConnectStep({ api, data, patch, onNext }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mid = data.merchantId.trim();
  const v = data.verify;

  async function verify() {
    setBusy(true);
    setError(null);
    patch({ verify: null, skipCommerce: false });
    try {
      patch({ verify: await api.verifyMerchant(mid) });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the verification service');
    } finally {
      setBusy(false);
    }
  }

  // Advance when the id verified, when the backend can't be checked here (soft-pass), or when the
  // merchant chose to set up their catalogue later.
  const canContinue = data.skipCommerce || v?.verified === true || v?.configured === false;

  return (
    <div className="ob-card">
      <h1 className="ob-title">Connect your commerce backend</h1>
      <p className="ob-lede">
        Your store's products, cart and checkout come from the commerce backend. Enter the merchant
        ID you were issued when your store was set up there.
      </p>

      <Field label="Merchant ID">
        <div className="ob-inline">
          <input
            className="input mono"
            placeholder="196jdfqy1aot"
            value={data.merchantId}
            onChange={(e) => patch({ merchantId: e.target.value, verify: null })}
            autoFocus
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={verify}
            disabled={busy || !/^[A-Za-z0-9_-]{1,64}$/.test(mid)}
          >
            {busy ? <Spinner /> : 'Verify'}
          </button>
        </div>
      </Field>

      {error && (
        <div className="note note-error" role="alert">
          {error}
        </div>
      )}
      {v?.verified && (v.collectionCount ?? 0) > 0 && (
        <div className="note note-ok" role="status">
          ✓ Connected — found {v.collectionCount} collection{v.collectionCount === 1 ? '' : 's'}.
        </div>
      )}
      {v?.verified && (v.collectionCount ?? 0) === 0 && (
        <div className="note note-warn" role="status">
          Connected, but no collections were found. Double-check the ID, or continue and add your
          catalogue later.
        </div>
      )}
      {v && !v.verified && v.configured && (
        <div className="note note-error" role="alert">
          We couldn't verify this merchant ID against the backend. Check it and try again.
        </div>
      )}
      {v && !v.configured && (
        <div className="note note-warn" role="status">
          The commerce backend isn't available in this environment, so we can't verify here — you
          can continue.
        </div>
      )}

      <div className="ob-actions">
        <button
          type="button"
          className="ob-link"
          onClick={() => patch({ skipCommerce: true, verify: null })}
        >
          I'll set up my catalogue later
        </button>
        <button type="button" className="btn btn-primary" disabled={!canContinue} onClick={onNext}>
          Continue
        </button>
      </div>
    </div>
  );
}
