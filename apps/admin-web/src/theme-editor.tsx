import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Api, type Store, type ThemeFiles } from './api';
import { EmptyState, Icon, Spinner, useToast } from './ui';
import { storefrontUrl } from './store-context';
import { CodeEditor } from './code-editor';

type Status = 'loading' | 'ready' | 'disabled' | 'error';

// Group flat file paths into one level of folders (like a Shopify theme: sections/, snippets/,
// templates/, …), with root-level files last. One level covers real theme layouts; deeper nesting is
// a later polish.
function groupByFolder(
  paths: string[]
): { folder: string; files: { path: string; name: string }[] }[] {
  const groups = new Map<string, { path: string; name: string }[]>();
  for (const p of paths) {
    const slash = p.indexOf('/');
    const folder = slash === -1 ? '' : p.slice(0, slash);
    const name = slash === -1 ? p : p.slice(slash + 1);
    const list = groups.get(folder) ?? [];
    list.push({ path: p, name });
    groups.set(folder, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([folder, files]) => ({
      folder,
      files: files.sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

// The merchant theme CODE editor (OFCE-601): file tree + code editor + save/publish, on the store's
// working bundle theme. Distinct from the token-based Theme Settings panel. Live-draft preview and a
// version-history/rollback panel are follow-ups (rollback needs a bundle versions endpoint).
export function ThemeCodeEditor({
  api,
  store,
  isLocal,
}: {
  api: Api;
  store: Store;
  isLocal: boolean;
}) {
  const toast = useToast();
  const [files, setFiles] = useState<ThemeFiles>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const canPublish = store.role === 'owner';

  function toggleFolder(folder: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  const load = useCallback(() => {
    setStatus('loading');
    api
      .getBundleDraft(store.id)
      // A brand-new store has no theme files yet — seed a default starter so the editor opens with a
      // working folder structure instead of empty. The seed is persisted server-side (not a dirty edit).
      .then((f) => (Object.keys(f).length === 0 ? api.scaffoldBundleDraft(store.id) : f))
      .then((f) => {
        setFiles(f);
        setSelected((s) => s ?? Object.keys(f).sort()[0] ?? null);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        // 503 = the bundle store isn't configured for this environment (BUNDLE_S3_BUCKET unset).
        if (e instanceof ApiError && e.status === 503) {
          setStatus('disabled');
          return;
        }
        setErrMsg(e instanceof Error ? e.message : 'Could not load the theme');
        setStatus('error');
      });
  }, [api, store.id]);
  useEffect(load, [load]);

  function editFile(path: string, content: string) {
    setFiles((f) => ({ ...f, [path]: content }));
    setDirty(true);
  }

  function addFile() {
    const path = newPath.trim();
    if (!path) return;
    if (path in files) {
      toast('That file already exists', 'error');
      return;
    }
    setFiles((f) => ({ ...f, [path]: '' }));
    setSelected(path);
    setNewPath('');
    setDirty(true);
  }

  function deleteFile(path: string) {
    setFiles((f) => {
      const next = { ...f };
      delete next[path];
      return next;
    });
    setSelected((s) => (s === path ? null : s));
    setDirty(true);
  }

  async function save(): Promise<boolean> {
    setBusy(true);
    try {
      await api.saveBundleDraft(store.id, files);
      setDirty(false);
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (await save()) toast('Draft saved', 'ok');
  }

  async function publish() {
    if (Object.keys(files).length === 0) {
      toast('Add a file before publishing', 'error');
      return;
    }
    // Publish serves the saved draft, so flush any pending edits first.
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const res = await api.publishBundle(store.id);
      toast(`Published theme v${res.version}`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const url = storefrontUrl(store, isLocal);
  const paths = Object.keys(files).sort();
  const groups = groupByFolder(paths);
  const ready = status === 'ready';

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>Theme code {dirty && <span className="muted">· unsaved</span>}</h2>
        <div className="row" style={{ gap: 8 }}>
          {url && (
            <a className="btn btn-ghost btn-sm" href={url} target="_blank" rel="noreferrer">
              View live <Icon.external />
            </a>
          )}
          <button className="btn btn-sm" onClick={saveDraft} disabled={busy || !dirty || !ready}>
            Save draft
          </button>
          {canPublish && (
            <button className="btn btn-primary btn-sm" onClick={publish} disabled={busy || !ready}>
              Publish
            </button>
          )}
        </div>
      </div>

      {status === 'loading' && <Spinner />}

      {status === 'disabled' && (
        <EmptyState emoji="🔒" title="Theme code editing isn't enabled here">
          This environment has no theme bundle store configured. Set <code>BUNDLE_S3_BUCKET</code>{' '}
          (and its S3 credentials) on the admin API to edit theme code.
        </EmptyState>
      )}

      {status === 'error' && (
        <EmptyState emoji="⚠️" title="Couldn't load the theme">
          <p className="muted">{errMsg}</p>
          <button className="btn btn-sm" onClick={load}>
            Retry
          </button>
        </EmptyState>
      )}

      {ready && (
        <div className="ide">
          <aside className="ide-sidebar">
            <div className="ide-sidebar-head">Explorer</div>
            <div className="ide-tree">
              {paths.length === 0 ? (
                <div className="muted tree-empty">No files yet</div>
              ) : (
                <ul className="tree-list">
                  {groups.map((g) => {
                    const open = !collapsed.has(g.folder);
                    return (
                      <li key={g.folder || '/'}>
                        {g.folder && (
                          <button
                            className="tree-folder"
                            aria-expanded={open}
                            onClick={() => toggleFolder(g.folder)}
                          >
                            <span className="caret">{open ? '▾' : '▸'}</span>
                            {g.folder}
                          </button>
                        )}
                        {open && (
                          <ul className={g.folder ? 'tree-files nested' : 'tree-files'}>
                            {g.files.map((f) => (
                              <li key={f.path} className={f.path === selected ? 'active' : ''}>
                                <button className="tree-item" onClick={() => setSelected(f.path)}>
                                  {f.name}
                                </button>
                                {confirmDelete === f.path ? (
                                  <span className="row" style={{ gap: 2 }}>
                                    <button
                                      className="btn-icon danger"
                                      aria-label={`Confirm delete ${f.path}`}
                                      onClick={() => {
                                        deleteFile(f.path);
                                        setConfirmDelete(null);
                                      }}
                                    >
                                      <Icon.check />
                                    </button>
                                    <button
                                      className="btn-icon"
                                      aria-label="Cancel delete"
                                      onClick={() => setConfirmDelete(null)}
                                    >
                                      ✕
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    className="btn-icon"
                                    aria-label={`Delete ${f.path}`}
                                    onClick={() => setConfirmDelete(f.path)}
                                  >
                                    <Icon.trash />
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="ide-add row" style={{ gap: 6 }}>
              <input
                className="input"
                placeholder="new/file.liquid"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addFile()}
              />
              <button className="btn btn-sm" onClick={addFile} aria-label="Add file">
                <Icon.plus />
              </button>
            </div>
          </aside>

          <div className="ide-editor">
            {selected && files[selected] !== undefined ? (
              <CodeEditor
                path={selected}
                initialValue={files[selected]}
                onChange={(v) => editFile(selected, v)}
              />
            ) : (
              <div className="ide-empty muted">
                Select a file to edit, or add one to get started.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
