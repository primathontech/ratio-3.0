import { useEffect, useMemo, useState } from 'react';
import type { Api, BaseThemeStatus, BaseRebasePlan, BaseRebaseOutcome } from '../../common/api';
import { ApiError } from '../../common/api';
import { Spinner, Dialog, useToast } from '../../common/ui';
import { BaseThemeTable } from './base-theme-table';

// Platform-admin "Base theme" console (OFCE-633 Phase 3). Improving the shared base theme is a code +
// deploy step; this console then lets an operator SEE which stores are behind and pull the improvement
// into them — previewed and staged (pick a canary set → apply → then the rest), never all-at-once by
// default. This is the container: it owns all state + handlers and composes the presentational table.

// A 400 from apply/preview comes back as a JSON `{ error }` body inside ApiError.message — surface the
// message, not the raw JSON.
function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    try {
      const b = JSON.parse(e.message) as { error?: string };
      if (b.error) return b.error;
    } catch {
      /* not JSON */
    }
    return e.message;
  }
  return (e as Error).message;
}

export function BaseThemeConsole({ api }: { api: Api }) {
  const [status, setStatus] = useState<BaseThemeStatus | null>(null);
  const [plan, setPlan] = useState<BaseRebasePlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Record<string, BaseRebaseOutcome> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api
      .getBaseTheme()
      .then(setStatus)
      .catch((e) => setError(errorText(e)));
  }, [api]);

  const selectableIds = useMemo(
    () => (plan?.targets ?? []).filter((t) => !t.blocked && !t.error).map((t) => t.themeId),
    [plan]
  );

  async function runPreview() {
    setBusy(true);
    setError(null);
    setOutcomes(null);
    setSelected(new Set());
    try {
      setPlan(await api.previewBasePropagation());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(themeId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(themeId)) next.delete(themeId);
      else next.add(themeId);
      return next;
    });
  }

  // Only unblocked, non-errored, selected targets are ever applied. The table already disables blocked
  // checkboxes; this is the defense-in-depth in the apply path itself, so no future table change can leak
  // a dirty-draft / broken-layout store into this destructive call.
  const selectedTargets = (plan?.targets ?? []).filter(
    (t) => selected.has(t.themeId) && !t.blocked && !t.error
  );

  async function apply() {
    if (!plan || selectedTargets.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { outcomes: results } = await api.applyBasePropagation(
        selectedTargets.map((t) => ({ tenantId: t.tenantId, themeId: t.themeId })),
        plan.latestVersion
      );
      setOutcomes(Object.fromEntries(results.map((o) => [o.themeId, o])));
      const ok = results.filter((o) => o.ok && !o.skipped).length;
      const skipped = results.filter((o) => o.skipped).length;
      const failed = results.filter((o) => !o.ok).length;
      toast(
        `Applied to ${ok} store${ok === 1 ? '' : 's'}` +
          (skipped ? `, ${skipped} skipped` : '') +
          (failed ? `, ${failed} failed` : ''),
        failed ? 'error' : 'ok'
      );
      setSelected(new Set());
      // Refresh the behind-count so applied stores drop out of the headline number.
      api
        .getBaseTheme()
        .then(setStatus)
        .catch(() => {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!status && !error) {
    return (
      <div className="center-pad">
        <Spinner />
      </div>
    );
  }

  // Stores still behind: from the plan, minus any this session already rebased (a successful outcome),
  // so the headline drops as stores are applied — not stuck on the pre-apply preview count. Falls back to
  // the server status before a preview is run.
  const behind = plan
    ? plan.targets.filter((t) => !outcomes?.[t.themeId]?.ok).length
    : (status?.storesBehind ?? 0);
  const latest = plan?.latestVersion ?? status?.latestVersion ?? null;

  return (
    <div className="fade-in">
      <div className="page-head">
        <div className="head-text">
          <h1>Base theme</h1>
          <p>Pull the latest base into stores that are behind, without losing their edits.</p>
        </div>
        <button className="btn btn-primary" onClick={runPreview} disabled={busy}>
          {busy && !confirming ? 'Loading…' : plan ? 'Refresh preview' : 'Preview propagation'}
        </button>
      </div>

      {error && (
        <div className="note note-error" role="alert">
          {error}
        </div>
      )}

      <div className="card" style={{ padding: '14px 16px', marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 16 }}>
          <span style={{ fontSize: 22, fontWeight: 600 }}>
            {latest != null ? `Base v${latest}` : 'No base published yet'}
          </span>
          <span style={{ color: 'var(--muted)' }}>
            {behind === 0
              ? 'All stores up to date'
              : `${behind} store${behind === 1 ? '' : 's'} behind`}
          </span>
        </div>
      </div>

      {plan && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 12,
              padding: '12px 16px',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
              {selected.size} of {selectableIds.length} selectable stores chosen
            </span>
            <div style={{ flex: 1 }} />
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setSelected(new Set(selectableIds))}
              disabled={selectableIds.length === 0}
            >
              Select all ready
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
            >
              Clear
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setConfirming(true)}
              disabled={busy || selected.size === 0}
            >
              Apply to {selected.size} selected
            </button>
          </div>
          <BaseThemeTable
            targets={plan.targets}
            selected={selected}
            outcomes={outcomes}
            onToggle={toggle}
          />
        </div>
      )}

      {confirming && (
        <Dialog
          title={`Apply base v${latest} to ${selected.size} store${selected.size === 1 ? '' : 's'}?`}
          onClose={() => (busy ? undefined : setConfirming(false))}
        >
          <div className="body">
            This republishes each selected store’s live storefront onto the new base. Their own
            edits are kept; only files they didn’t change advance. Stores that overrode a changed
            base file (their “shadowed” count) won’t pick up that file.
          </div>
          <div className="actions">
            <button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={apply} disabled={busy}>
              {busy ? 'Applying…' : `Apply to ${selected.size}`}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
