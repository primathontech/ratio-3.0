import { useState } from 'react';
import type { Api, Store } from '../../common/api';
import { Field, Icon, Spinner, useToast } from '../../common/ui';

// Bring-your-own-AI (ADR-007): mint a short-lived key scoped to this store and hand it to
// an AI assistant, which then drives the same control-plane API the dashboard uses.
export function AgentAccessPanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [key, setKey] = useState<{ token: string; scope: string[]; expiresIn: number } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      setKey(await api.mintAgentToken(store.id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key.token);
      toast('Access key copied');
    } catch {
      // Don't claim success when the copy failed (M3) — the token is shown only once.
      toast('Copy failed — select the key and copy it manually', 'error');
    }
  }

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>AI assistant access</h2>
        <button className="btn btn-ghost btn-sm" onClick={generate} disabled={busy}>
          {busy ? <Spinner /> : <Icon.plus size={14} />} Generate access key
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Give an AI assistant a key to edit <strong>this store only</strong>. It expires
        automatically. Anyone with the key can edit this store until it expires — share it
        carefully. Generating a new key does <strong>not</strong> disable an old one; each key stays
        valid until it expires.
      </p>
      {err && (
        <div className="note note-error" role="alert">
          {err}
        </div>
      )}
      {key && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Access key">
              <input
                className="input mono"
                readOnly
                value={key.token}
                onFocus={(e) => e.target.select()}
              />
            </Field>
            <button type="button" className="btn btn-subtle" onClick={copy}>
              <Icon.check size={13} /> Copy
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            Scope: <span className="mono">{key.scope.join(', ')}</span> · expires in{' '}
            {Math.round(key.expiresIn / 60)} min
          </p>
        </div>
      )}
    </div>
  );
}
