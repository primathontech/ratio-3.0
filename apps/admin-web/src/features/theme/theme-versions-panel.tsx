import { useCallback, useEffect, useState } from 'react';
import type { Api, Store, ThemeVersion } from '../../common/api';
import { Field, Icon, Spinner, useToast } from '../../common/ui';

// Publish + rollback the store's theme versions. Publishing snapshots the whole store as an immutable
// version and takes it live; rollback moves the live pointer to any earlier version (non-destructive).
export function ThemeVersionsPanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [published, setPublished] = useState<number | null>(null);
  const [versions, setVersions] = useState<ThemeVersion[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .themeVersions(store.id)
      .then((d) => {
        setPublished(d.published);
        setVersions(d.versions);
      })
      .catch((e: Error) => setErr(e.message));
  }, [api, store.id]);
  useEffect(load, [load]);

  async function publish() {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.publishTheme(store.id, note.trim() || undefined, published);
      toast(`Published theme v${res.version}`, 'ok');
      setNote('');
      load();
    } catch (e) {
      setErr((e as Error).message);
      toast('Could not publish the theme', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function rollback(v: number) {
    setBusy(true);
    setErr(null);
    try {
      await api.rollbackTheme(store.id, v);
      toast(`Rolled back to v${v}`, 'ok');
      load();
    } catch (e) {
      setErr((e as Error).message);
      toast('Could not roll back', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>Theme versions</h2>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>
        Publishing snapshots the whole store (all pages + theme tokens) as an immutable version and
        takes it live. Roll back to any earlier version at any time — it's non-destructive.
      </p>
      <Field label="Note (optional)">
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Diwali homepage"
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
        onClick={publish}
        disabled={busy}
        style={{ marginTop: 10 }}
      >
        {busy ? <Spinner /> : <Icon.check />} Publish theme
      </button>

      <div style={{ marginTop: 16 }}>
        {versions === null ? (
          <Spinner />
        ) : versions.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            Nothing published yet.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {versions.map((v) => (
              <li
                key={v.version}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 0',
                  borderTop: '1px solid var(--border, #eee)',
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <strong>v{v.version}</strong>
                  {v.version === published && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        color: 'var(--ok, #137333)',
                        fontWeight: 600,
                      }}
                    >
                      ● live
                    </span>
                  )}
                  {v.note && (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      {v.note}
                    </span>
                  )}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </span>
                {v.version !== published && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => rollback(v.version)}
                    disabled={busy}
                  >
                    Roll back
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
