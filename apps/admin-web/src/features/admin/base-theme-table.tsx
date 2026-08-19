import type { BaseRebaseTarget, BaseRebaseOutcome, RebaseBlock } from '../../common/api';

// Presentational: the propagation preview as a selectable table. One row per store behind the base —
// pick which to rebase (canary → all), see what each rebase carries and what it would shadow, and, once
// applied, the per-store result. Props-only (the container owns all state), so it renders with
// renderToStaticMarkup in tests.

const BLOCK_LABEL: Record<RebaseBlock, string> = {
  'dirty-draft': 'unpublished draft',
  'broken-layout': 'broken layout',
};

// Why a store can't be selected/applied right now, if anything.
function blockNote(t: BaseRebaseTarget): string | null {
  if (t.error) return t.error;
  if (t.blocked === 'dirty-draft')
    return 'has unpublished draft edits — publish or reset before rebasing';
  if (t.blocked === 'broken-layout')
    return 'its live layout is not a full HTML document — fix before rebasing';
  return null;
}

function StatusPill({ t }: { t: BaseRebaseTarget }) {
  if (t.error) return <span className="pill pill-err">error</span>;
  if (t.blocked) return <span className="pill pill-warn">{BLOCK_LABEL[t.blocked]}</span>;
  return <span className="pill pill-ok">ready</span>;
}

function OutcomePill({ o }: { o: BaseRebaseOutcome }) {
  if (!o.ok) return <span className="pill pill-err">failed</span>;
  if (o.skipped) return <span className="pill">skipped</span>;
  return (
    <span className="pill pill-ok">{o.madeLive ? `live · v${o.version}` : `v${o.version}`}</span>
  );
}

export function BaseThemeTable({
  targets,
  selected,
  outcomes,
  onToggle,
}: {
  targets: BaseRebaseTarget[];
  selected: Set<string>; // themeIds
  outcomes: Record<string, BaseRebaseOutcome> | null; // by themeId, after an apply
  onToggle: (themeId: string) => void;
}) {
  const showResult = outcomes != null;
  const colCount = showResult ? 7 : 6;
  return (
    <div className="table-wrap">
      <table className="data-table" style={{ minWidth: 720 }}>
        <thead>
          <tr>
            <th style={{ width: 36 }} aria-label="Select" />
            <th>Store</th>
            <th>Base</th>
            <th>Status</th>
            <th className="num">Overrides</th>
            <th className="num">Shadowed</th>
            {showResult && <th>Result</th>}
          </tr>
        </thead>
        <tbody>
          {targets.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="table-empty">
                <span className="table-empty-emoji" aria-hidden>
                  🎉
                </span>
                Every store is on the latest base.
              </td>
            </tr>
          ) : (
            targets.map((t) => {
              const note = blockNote(t);
              const selectable = !t.blocked && !t.error;
              const outcome = outcomes?.[t.themeId];
              return (
                <tr key={t.themeId} style={{ opacity: selectable ? 1 : 0.6 }}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(t.themeId)}
                      disabled={!selectable}
                      onChange={() => onToggle(t.themeId)}
                      aria-label={`Select ${t.name}`}
                    />
                  </td>
                  <td>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{t.name}</span>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                        {t.tenantId}
                      </span>
                    </span>
                  </td>
                  <td>
                    v{t.fromVersion} → v{t.toVersion}
                    {t.isLive && (
                      <span className="badge" style={{ marginLeft: 8 }}>
                        live
                      </span>
                    )}
                  </td>
                  <td title={note ?? undefined}>
                    <StatusPill t={t} />
                  </td>
                  <td className="num">{t.overrideCount}</td>
                  <td
                    className="num"
                    title={t.shadowedFiles.length ? t.shadowedFiles.join(', ') : undefined}
                    style={t.shadowedFiles.length ? { color: 'var(--warn, #b45309)' } : undefined}
                  >
                    {t.shadowedFiles.length}
                  </td>
                  {showResult && (
                    <td title={outcome?.error ?? outcome?.purgeError ?? undefined}>
                      {outcome ? (
                        <OutcomePill o={outcome} />
                      ) : (
                        <span style={{ color: 'var(--text-3)' }}>—</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
