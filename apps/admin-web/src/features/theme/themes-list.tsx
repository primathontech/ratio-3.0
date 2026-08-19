import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  canManageStore,
  type Api,
  type Store,
  type ThemeSummary,
} from '../../common/api';
import { Dialog, EmptyState, Field, Icon, Spinner, useToast } from '../../common/ui';
import { PageHeader } from '../../common/page-header';
import { storeSlug, storefrontUrl } from '../../common/store-context';
import { ThemeCard, type Preview } from './theme-card';
import './themes-list.css';

type Status = 'loading' | 'ready' | 'disabled' | 'error';

// The Themes landing (OFCE-615): the store's theme library as a grid, backed by the real multi-theme
// API. This is the container — it owns the theme list, per-theme preview thumbnails, and the
// create/rename/duplicate/delete/set-live flows, and composes the presentational <ThemeCard/>.
export function ThemesList({ api, store }: { api: Api; store: Store }) {
  const navigate = useNavigate();
  const toast = useToast();
  const slug = storeSlug(store);
  const domain = store.host ?? store.id;
  const liveUrl = storefrontUrl(store, false);
  const canManage = canManageStore(store);

  const [status, setStatus] = useState<Status>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});

  const [renameTarget, setRenameTarget] = useState<ThemeSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ThemeSummary | null>(null);
  const [duplicateTarget, setDuplicateTarget] = useState<ThemeSummary | null>(null);
  const [duplicateName, setDuplicateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('New theme');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setStatus('loading');
    api
      .listThemes(store.id)
      .then((list) => {
        setThemes(list);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 503) {
          setStatus('disabled');
          return;
        }
        setErrMsg(e instanceof Error ? e.message : 'Could not load themes');
        setStatus('error');
      });
  }, [api, store.id]);
  useEffect(load, [load]);

  // Render each theme's saved home page (no files → saved state) into its card thumbnail. Keyed on the
  // set of theme ids, so it only refetches when a theme is added/removed, not on every render.
  const themeIds = themes.map((t) => t.id).join(',');
  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    for (const theme of themes) {
      setPreviews((p) => (p[theme.id] ? p : { ...p, [theme.id]: { status: 'loading', html: '' } }));
      api
        .previewBundle(store.id, theme.id)
        .then((r) => {
          if (cancelled) return;
          const html = r.error ? '' : (r.html ?? '');
          setPreviews((p) => ({ ...p, [theme.id]: { status: html ? 'ok' : 'empty', html } }));
        })
        .catch(() => {
          if (cancelled) return;
          setPreviews((p) => ({ ...p, [theme.id]: { status: 'empty', html: '' } }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, store.id, themeIds, status]);

  function editTheme(theme: ThemeSummary) {
    navigate(`/stores/${slug}/themes/${theme.id}/editor`, { state: { fromApp: true } });
  }

  async function setLive(theme: ThemeSummary) {
    setBusy(true);
    try {
      await api.activateTheme(store.id, theme.id);
      toast(`${theme.name} is now live`, 'ok');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // Duplicate opens a naming dialog (prefilled "Copy of …") and drops into the editor on the new theme,
  // matching Create — instead of a silent one-click copy with a server-default name.
  async function submitDuplicate(e: FormEvent) {
    e.preventDefault();
    if (!duplicateTarget) return;
    setBusy(true);
    try {
      const { id } = await api.createTheme(store.id, {
        name: duplicateName.trim() || `Copy of ${duplicateTarget.name}`,
        duplicateOf: duplicateTarget.id,
      });
      setDuplicateTarget(null);
      navigate(`/stores/${slug}/themes/${id}/editor`, { state: { fromApp: true } });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function submitRename(e: FormEvent) {
    e.preventDefault();
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.renameTheme(store.id, renameTarget.id, name);
      setRenameTarget(null);
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.deleteTheme(store.id, deleteTarget.id);
      toast(`Deleted ${deleteTarget.name}`, 'ok');
      setDeleteTarget(null);
      load();
    } catch (e) {
      // The backend refuses the live theme with a 409 — surface it plainly instead of a raw error.
      const msg =
        e instanceof ApiError && e.status === 409
          ? "You can't delete the live theme. Set another theme live first."
          : (e as Error).message;
      toast(msg, 'error');
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  }

  async function submitCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { id } = await api.createTheme(store.id, { name: newName.trim() || 'New theme' });
      setCreating(false);
      navigate(`/stores/${slug}/themes/${id}/editor`, { state: { fromApp: true } });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-in">
      <PageHeader
        title="Themes"
        description={
          <>
            One theme is live on <span className="themes-domain">{domain}</span>. Customize it, edit
            the code, or spin up another.
          </>
        }
      >
        {/* Creating a theme is member-allowed (backend requireMembership), same as the card's
            Duplicate — only publish/activate/delete are owner-only. */}
        <button
          className="btn btn-primary"
          disabled={status !== 'ready'}
          onClick={() => {
            setNewName('New theme');
            setCreating(true);
          }}
        >
          <Icon.plus /> New theme
        </button>
      </PageHeader>

      {status === 'loading' && (
        <div className="center-pad">
          <Spinner />
        </div>
      )}

      {status === 'disabled' && (
        <EmptyState emoji="🔒" title="Themes aren't enabled here">
          This environment has no theme bundle store configured. Set <code>BUNDLE_S3_BUCKET</code>{' '}
          (and its S3 credentials) on the admin API to manage themes.
        </EmptyState>
      )}

      {status === 'error' && (
        <EmptyState emoji="⚠️" title="Couldn't load themes">
          <p className="muted">{errMsg}</p>
          <button className="btn btn-sm" onClick={load}>
            Retry
          </button>
        </EmptyState>
      )}

      {status === 'ready' && (
        <div className="themes-grid">
          {themes.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              preview={previews[theme.id] ?? { status: 'loading', html: '' }}
              domain={domain}
              liveUrl={liveUrl}
              canManage={canManage}
              onEdit={() => editTheme(theme)}
              onCustomize={() => navigate(`/stores/${slug}/themes/${theme.id}`)}
              onSetLive={() => setLive(theme)}
              onRename={() => {
                setRenameValue(theme.name);
                setRenameTarget(theme);
              }}
              onDuplicate={() => {
                setDuplicateName(`Copy of ${theme.name}`);
                setDuplicateTarget(theme);
              }}
              onDelete={() => setDeleteTarget(theme)}
            />
          ))}
        </div>
      )}

      {creating && (
        <Dialog title="New theme" onClose={() => setCreating(false)}>
          <form onSubmit={submitCreate}>
            <div className="body">
              <Field label="Name">
                <input
                  className="input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
              </Field>
              <p className="muted" style={{ fontSize: 13 }}>
                Starts from the shared default theme. You'll drop straight into the code editor.
              </p>
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setCreating(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? <Spinner /> : <Icon.plus />} Create theme
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {duplicateTarget && (
        <Dialog
          title={`Duplicate ${duplicateTarget.name}`}
          onClose={() => setDuplicateTarget(null)}
        >
          <form onSubmit={submitDuplicate}>
            <div className="body">
              <Field label="Name">
                <input
                  className="input"
                  value={duplicateName}
                  onChange={(e) => setDuplicateName(e.target.value)}
                  autoFocus
                />
              </Field>
              <p className="muted" style={{ fontSize: 13 }}>
                Copies this theme's edits into a new theme. You'll drop straight into the code
                editor.
              </p>
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setDuplicateTarget(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !duplicateName.trim()}
              >
                {busy ? <Spinner /> : <Icon.files />} Duplicate theme
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {renameTarget && (
        <Dialog title="Rename theme" onClose={() => setRenameTarget(null)}>
          <form onSubmit={submitRename}>
            <div className="body">
              <Field label="Name">
                <input
                  className="input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  autoFocus
                />
              </Field>
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setRenameTarget(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !renameValue.trim()}
              >
                {busy ? <Spinner /> : null} Save
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {deleteTarget && (
        <Dialog title={`Delete ${deleteTarget.name}?`} onClose={() => setDeleteTarget(null)}>
          <div className="body">
            <p className="muted">
              This permanently removes the theme and its saved edits. This can't be undone.
            </p>
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={confirmDelete}
              disabled={busy}
            >
              {busy ? <Spinner /> : <Icon.trash />} Delete theme
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
