import { useEffect, useState } from 'react';
import type { Api, Store } from '../../common/api';
import { Field, Icon, Spinner, useToast } from '../../common/ui';

export function CommercePanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getCommerce(store.id)
      .then(setMerchantId)
      .catch((e: Error) => {
        setMerchantId('');
        setErr(e.message);
      });
  }, [api, store.id]);

  async function save() {
    if (merchantId === null) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await api.saveCommerce(store.id, merchantId.trim());
      setMerchantId(res.merchantId);
      toast(res.merchantId ? 'Commerce backend connected' : 'Commerce backend disconnected', 'ok');
    } catch (e) {
      setErr((e as Error).message);
      toast('Could not save the commerce backend', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>Commerce</h2>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>
        Connect the store's commerce backend by its GoKwik merchant id — this powers products,
        collections, cart, and checkout. Leave blank to disconnect.
      </p>
      {merchantId === null && !err ? (
        <Spinner />
      ) : (
        <>
          <Field label="Merchant ID">
            <input
              className="input mono"
              value={merchantId ?? ''}
              onChange={(e) => setMerchantId(e.target.value)}
              placeholder="e.g. 196jdfqy1aot"
            />
          </Field>
          {err && (
            <div className="note note-error" role="alert">
              {err}
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={saving}
            style={{ marginTop: 10 }}
          >
            {saving ? <Spinner /> : <Icon.check />} Save
          </button>
        </>
      )}
    </div>
  );
}
