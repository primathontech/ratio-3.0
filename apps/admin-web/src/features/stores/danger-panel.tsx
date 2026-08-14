import { useState } from 'react';
import type { Api, Store } from '../../common/api';
import { Dialog, Icon, useToast } from '../../common/ui';

// Permanently remove a store. Destructive + irreversible, so it's owner-only and gated behind a
// type-the-name confirmation. The API's DELETE /stores/:id does the transactional hard-delete
// (pages + domains + memberships) and cache/edge cleanup; this just triggers it and returns home.
export function DangerPanel({
  api,
  store,
  onDeleted,
}: {
  api: Api;
  store: Store;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      await api.deleteStore(store.id);
      toast('Store removed');
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      toast('Could not remove the store', 'error');
      setBusy(false);
    }
  }

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>Danger zone</h2>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 14px' }}>
        Removing this store permanently deletes it — its pages, domains, and access. This cannot be
        undone.
      </p>
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => {
          setTyped('');
          setErr(null);
          setConfirming(true);
        }}
      >
        <Icon.trash size={14} /> Remove store
      </button>
      {confirming && (
        <Dialog
          title="Remove this store?"
          onClose={() => (busy ? undefined : setConfirming(false))}
        >
          <div className="body">
            <p>
              This permanently deletes <span className="mono">{store.name}</span> and everything in
              it — pages, domains, and access. This cannot be undone.
            </p>
            <p style={{ marginTop: 12 }}>
              Type <span className="mono">{store.name}</span> to confirm:
            </p>
            <input
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Type the store name to confirm"
              autoFocus
            />
            {err && (
              <div className="note note-error" role="alert">
                {err}
              </div>
            )}
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={remove}
              disabled={busy || typed !== store.name}
            >
              <Icon.trash size={14} /> {busy ? 'Removing…' : 'Remove permanently'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
