import { useEffect, useState } from 'react';
import { Field, Spinner } from '../../../common/ui';
import { ApiError, type BaseThemeOption } from '../../../common/api';
import { BasePicker } from '../../theme/base-picker';
import { suggestHost, PLATFORM_DOMAIN } from '../host';
import type { StepProps } from '../types';

// Step 2 — store details. Name + a platform subdomain (auto-suggested from the name) + the "start
// from" base theme. Continuing CREATES the store as a draft (not live) on that base so the Design +
// Launch steps can work on a real theme with the merchant's real products; the wizard publishes it at
// the end. The base is locked once the store exists (a theme's base is immutable).
export function DetailsStep({ api, data, patch, onNext, onBack }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostTouched, setHostTouched] = useState(false);
  const [bases, setBases] = useState<BaseThemeOption[]>([]);

  // Load the start-from bases; default the selection to the first (the platform Default) unless the
  // merchant already picked one (e.g. navigated back). Best-effort — a failure just hides the picker.
  useEffect(() => {
    api
      .listBaseThemes()
      .then((list) => {
        setBases(list);
        if (!data.baseThemeId && list[0]) patch({ baseThemeId: list[0].id });
      })
      .catch(() => {});
  }, [api, data.baseThemeId, patch]);

  function onName(name: string) {
    // Keep the subdomain in sync with the name until the merchant edits it themselves.
    patch(hostTouched ? { name } : { name, host: suggestHost(name) });
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      if (data.storeId) {
        // Already created (navigated back then forward), so don't re-create. But the merchant may
        // have changed the merchant ID on the Connect step since — push it (an empty value
        // disconnects) so commerce doesn't stay stale. Only on an actual change: saveCommerce purges
        // the edge, so we don't fire it on every back/forward.
        const mid = data.merchantId.trim();
        if (mid !== data.savedMerchantId) {
          await api.saveCommerce(data.storeId, mid);
          patch({ savedMerchantId: mid });
        }
        onNext();
        return;
      }
      // Publish on create: the store goes LIVE on the default bundle theme immediately (what you see
      // in the editor), never a page-builder scaffold. The Design + Launch steps then edit and
      // republish it. OFCE-618.
      const mid = data.merchantId.trim();
      const res = await api.createStore({
        name: data.name.trim(),
        host: data.host.trim().toLowerCase(),
        merchantId: mid || undefined,
        baseThemeId: data.baseThemeId || undefined,
      });
      patch({
        storeId: res.id,
        storeUrl: res.url,
        themeId: `${res.id}-main`,
        savedMerchantId: mid,
      });
      onNext();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save your store');
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

      {!created && bases.length > 1 && (
        <Field label="Start from" info="Your theme's starting design. You can customise it next.">
          <BasePicker
            options={bases}
            value={data.baseThemeId}
            onChange={(id) => patch({ baseThemeId: id })}
          />
        </Field>
      )}

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
