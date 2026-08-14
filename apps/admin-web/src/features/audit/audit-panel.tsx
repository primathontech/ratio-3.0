import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, Store, AuditEntry } from '../../common/api';
import { Spinner } from '../../common/ui';

// Recent control-plane changes for this store (ADR-016 audit trail) — makes AI/human edits
// visible and accountable. Every mutation is one row; "AI" = an agent-token actor.
export function AuditPanel({ api, store }: { api: Api; store: Store }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    setErr(null);
    const seq = ++loadSeq.current; // latest-wins: a slow earlier load can't overwrite (M4)
    api
      .listAudit(store.id)
      .then((e) => {
        if (seq === loadSeq.current) setEntries(e);
      })
      .catch((e: Error) => {
        if (seq === loadSeq.current) setErr(e.message);
      });
  }, [api, store.id]);
  useEffect(load, [load]);

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>Recent changes</h2>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          Refresh
        </button>
      </div>
      {err && (
        <div className="note note-error" role="alert">
          {err}
        </div>
      )}
      {!entries && !err && (
        <div className="center-pad">
          <Spinner />
        </div>
      )}
      {entries && entries.length === 0 && (
        <p className="muted" style={{ fontSize: 12.5 }}>
          No changes recorded yet — edits made here or by an AI assistant will show up.
        </p>
      )}
      {entries && entries.length > 0 && (
        <div className="domain-rows">
          {entries.map((e, i) => (
            <div className="domain-row" key={`${e.at}-${i}`}>
              <span className="mono">{e.action}</span>
              <span className="badge">{e.actorKind === 'agent' ? 'AI' : 'you'}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {new Date(e.at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
