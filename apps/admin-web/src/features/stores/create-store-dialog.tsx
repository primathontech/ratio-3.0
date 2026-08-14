import { useState, type FormEvent } from 'react';
import type { Api } from '../../common/api';
import { Dialog, Field, Icon, Spinner } from '../../common/ui';

export function CreateStoreDialog({
  api,
  onClose,
  onCreated,
}: {
  api: Api;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [f, setF] = useState({ name: '', host: '', color: '#2563eb', merchantId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createStore({ ...f, merchantId: f.merchantId.trim() || undefined });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Create a store" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="body">
          <Field label="Name">
            <input
              className="input"
              placeholder="Acme"
              value={f.name}
              onChange={set('name')}
              required
            />
          </Field>
          <Field label="Domain">
            <input
              className="input"
              placeholder="acme.ratiodev.in"
              value={f.host}
              onChange={set('host')}
              required
            />
          </Field>
          <Field
            label="Merchant ID (gokwik)"
            info="Connects live products from the commerce backend. Optional — leave blank for a store with no catalogue yet."
          >
            <input
              className="input mono"
              placeholder="196jdfqy1aot"
              value={f.merchantId}
              onChange={set('merchantId')}
            />
          </Field>
          <Field label="Accent colour">
            <input
              className="input"
              type="color"
              value={f.color}
              onChange={set('color')}
              style={{ height: 42, padding: 4 }}
            />
          </Field>
          {err && (
            <div className="note note-error" role="alert">
              {err}
            </div>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : <Icon.plus />} Create store
          </button>
        </div>
      </form>
    </Dialog>
  );
}
