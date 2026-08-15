import { useState } from 'react';
import { Field, Spinner } from '../../../common/ui';
import { ApiError } from '../../../common/api';
import { suggestHost, PLATFORM_DOMAIN } from '../host';
import type { StepProps } from '../types';

// Step 2 — store details. Name + a platform subdomain (auto-suggested from the name). Continuing
// CREATES the store as a draft (not live) so the Design + Launch steps can work on a real theme with
// the merchant's real products; the wizard publishes it at the end.
export function DetailsStep({ api, data, patch, onNext, onBack }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostTouched, setHostTouched] = useState(false);

  function onName(name: string) {
    // Keep the subdomain in sync with the name until the merchant edits it themselves.
    patch(hostTouched ? { name } : { name, host: suggestHost(name) });
  }

  async function create() {
    if (data.storeId) return onNext(); // already created (e.g. navigated back then forward) — don't re-create
    setBusy(true);
    setError(null);
    try {
      const res = await api.createStore({
        name: data.name.trim(),
        host: data.host.trim().toLowerCase(),
        merchantId:
          data.skipCommerce || !data.merchantId.trim() ? undefined : data.merchantId.trim(),
        draft: true,
      });
      patch({ storeId: res.id, storeUrl: res.url, themeId: `${res.id}-main` });
      onNext();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the store');
    } finally {
      setBusy(false);
    }
  }

  const valid = data.name.trim().length > 0 && /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(data.host.trim());
  // Once the store is created (the merchant went forward then back), the name + address are fixed —
  // lock them so an edit here isn't silently ignored. They're changeable later in store settings.
  const created = !!data.storeId;

  return (
    <div className="ob-card">
      <h1 className="ob-title">Name your store</h1>
      <p className="ob-lede">This is what shoppers see, and where your store lives.</p>

      <Field label="Store name">
        <input
          className="input"
          placeholder="Acme"
          value={data.name}
          onChange={(e) => onName(e.target.value)}
          disabled={created}
          autoFocus
        />
      </Field>
      <Field
        label="Store address"
        info={`Your free ${PLATFORM_DOMAIN} subdomain. You can connect a custom domain later.`}
      >
        <input
          className="input mono"
          placeholder={`acme.${PLATFORM_DOMAIN}`}
          value={data.host}
          disabled={created}
          onChange={(e) => {
            setHostTouched(true);
            patch({ host: e.target.value });
          }}
        />
      </Field>

      {created && (
        <div className="note note-ok" role="status">
          Your store is created. You can change its name and address later in settings.
        </div>
      )}
      {error && (
        <div className="note note-error" role="alert">
          {error}
        </div>
      )}

      <div className="ob-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={create}
          disabled={busy || !valid}
        >
          {busy ? <Spinner /> : 'Continue'}
        </button>
      </div>
    </div>
  );
}
