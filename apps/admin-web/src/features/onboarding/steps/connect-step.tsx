import { useState } from 'react';
import { Field, Spinner } from '../../../common/ui';
import { ApiError } from '../../../common/api';
import type { StepProps } from '../types';

// Step 1 — the prerequisite: the merchant must already be onboarded on the commerce backend (they
// hold a merchant ID). Continue verifies it against the backend so a typo can't launch a store that
// shows nothing — on success we advance, on failure we stay and show the error. A merchant still
// building their catalogue can skip and connect later.
export function ConnectStep({ api, data, patch, onNext }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mid = data.merchantId.trim();
  const midValid = /^[A-Za-z0-9_-]{1,64}$/.test(mid);

  // Continue = verify then advance. Skip the check when the merchant opted to connect later; advance
  // on a verified id OR when the backend can't be checked in this environment (soft-pass); otherwise
  // stay on the step and surface the error.
  async function handleContinue() {
    if (data.skipCommerce) {
      onNext();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const v = await api.verifyMerchant(mid);
      patch({ verify: v });
      if (v.verified === true || v.configured === false) {
        onNext();
      } else {
        setError(
          "We couldn't verify this merchant ID against the backend. Check it and try again."
        );
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the verification service');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ob-card">
      <h1 className="ob-title">Connect your commerce backend</h1>
      <p className="ob-lede">
        Your store's products, cart and checkout come from the commerce backend. Enter the merchant
        ID you were issued when your store was set up there.
      </p>

      <Field label="Merchant ID">
        <input
          className="input mono"
          placeholder="196jdfqy1aot"
          value={data.merchantId}
          onChange={(e) => patch({ merchantId: e.target.value, verify: null })}
          autoFocus
        />
      </Field>

      {error && (
        <div className="note note-error" role="alert">
          {error}
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
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || (!data.skipCommerce && !midValid)}
          onClick={handleContinue}
        >
          {busy ? <Spinner /> : 'Continue'}
        </button>
      </div>
    </div>
  );
}
