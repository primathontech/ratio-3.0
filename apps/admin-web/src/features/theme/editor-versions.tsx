import { Spinner } from '../../common/ui';
import type { ThemeVersion } from '../../common/api';

// Presentational version-history drawer (OFCE-615 Phase 3): the theme's published versions newest
// first, the live one badged, an owner-only "roll back" on each non-live version, and a reset-to-base
// escape hatch in the footer. All behaviour (rollback, reset, refetch) lives in the ThemeCodeEditor
// container; this only renders and calls back.
export function EditorVersions({
  versions,
  liveVersion,
  loading,
  canRollback,
  busy,
  onRollback,
  onResetToBase,
  onClose,
}: {
  versions: ThemeVersion[];
  liveVersion: number | null;
  loading: boolean;
  canRollback: boolean;
  busy: boolean;
  onRollback: (version: number) => void;
  onResetToBase: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="wb-versions" aria-label="Version history">
      <div className="wb-versions-head">
        <span className="wb-ws-name">Version history</span>
        <button className="btn-icon" onClick={onClose} aria-label="Close version history">
          ✕
        </button>
      </div>

      <div className="wb-versions-body">
        {loading ? (
          <div className="wb-center">
            <Spinner />
          </div>
        ) : versions.length === 0 ? (
          <p className="tree-empty muted">
            Not published yet. Publish to cut this theme's first version.
          </p>
        ) : (
          <ul className="wb-versions-list">
            {versions.map((v) => {
              const isLive = v.version === liveVersion;
              return (
                <li key={v.version} className={isLive ? 'wb-version live' : 'wb-version'}>
                  <div className="wb-version-row">
                    <span className="wb-version-num">v{v.version}</span>
                    {isLive && <span className="badge badge-accent">● Live</span>}
                    <span style={{ flex: 1 }} />
                    {canRollback && !isLive && (
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => onRollback(v.version)}
                      >
                        Roll back to this version
                      </button>
                    )}
                  </div>
                  <div className="wb-version-meta muted">
                    {new Date(v.createdAt).toLocaleString()}
                    {v.createdBy ? ` · ${v.createdBy}` : ''}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="wb-versions-foot">
        <button className="btn btn-sm btn-danger" disabled={busy} onClick={onResetToBase}>
          Reset to base theme
        </button>
        <p className="muted">Removes all your customizations and restores the default theme.</p>
      </div>
    </aside>
  );
}
