import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Api, type Store, type ThemeFiles } from '../../common/api';
import { EmptyState, Icon, Spinner, useToast } from '../../common/ui';
import { storefrontUrl } from '../../common/store-context';
import { CodeEditor } from './code-editor';
import './theme-editor.css';

type Status = 'loading' | 'ready' | 'disabled' | 'error';

// Group flat file paths into one level of folders (like a Shopify theme: sections/, snippets/,
// templates/, …), with root-level files last. One level covers real theme layouts.
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

// A small VS Code-Seti-style file glyph (text badge + colour class) by extension.
function fileGlyph(path: string): { text: string; cls: string } {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'js' || ext === 'mjs' || ext === 'ts') return { text: 'JS', cls: 'fi-js' };
  if (ext === 'json') return { text: '{}', cls: 'fi-json' };
  if (ext === 'css') return { text: '#', cls: 'fi-css' };
  if (ext === 'html' || ext === 'htm') return { text: '<>', cls: 'fi-html' };
  if (ext === 'liquid') return { text: '≈', cls: 'fi-liquid' };
  return { text: '•', cls: 'fi-default' };
}

function languageLabel(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return (
    {
      js: 'JavaScript',
      mjs: 'JavaScript',
      ts: 'TypeScript',
      json: 'JSON',
      css: 'CSS',
      liquid: 'Liquid',
      html: 'HTML',
    }[ext] ?? 'Plain Text'
  );
}

// The merchant theme code editor (OFCE-601): a VS Code-style workbench — activity bar, Explorer, Monaco
// editor, live preview, status bar — over the store's working bundle theme. `onBack` renders it as a
// full-screen route (its own chrome-less page); without it, it renders inline.
export function ThemeCodeEditor({
  api,
  store,
  isLocal,
  onBack,
}: {
  api: Api;
  store: Store;
  isLocal: boolean;
  onBack?: () => void;
}) {
  const toast = useToast();
  const [files, setFiles] = useState<ThemeFiles>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [showExplorer, setShowExplorer] = useState(true);
  const [showSearch, setShowSearch] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewErr, setPreviewErr] = useState('');
  const [previewing, setPreviewing] = useState(false);
  // Set when the new-file input is cancelled (Escape), so the unmount-triggered blur doesn't re-create
  // the file the user just cancelled.
  const addCancelled = useRef(false);
  const canPublish = store.role === 'owner';

  function toggleFolder(folder: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  // Render the given files server-side (the storefront's own render path) into the preview iframe.
  const runPreview = useCallback(
    async (f: ThemeFiles) => {
      setPreviewing(true);
      try {
        const res = await api.previewBundle(store.id, f);
        setPreviewErr(res.error ?? '');
        setPreviewHtml(res.error ? '' : (res.html ?? ''));
      } catch (e) {
        setPreviewErr(e instanceof Error ? e.message : 'Preview failed');
        setPreviewHtml('');
      } finally {
        setPreviewing(false);
      }
    },
    [api, store.id]
  );

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
        void runPreview(f);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 503) {
          setStatus('disabled');
          return;
        }
        setErrMsg(e instanceof Error ? e.message : 'Could not load the theme');
        setStatus('error');
      });
  }, [api, store.id, runPreview]);
  useEffect(load, [load]);

  function editFile(path: string, content: string) {
    setFiles((f) => ({ ...f, [path]: content }));
    setDirty(true);
  }

  function addFile() {
    if (addCancelled.current) {
      addCancelled.current = false;
      setAdding(false);
      setNewPath('');
      return;
    }
    const path = newPath.trim();
    if (!path) {
      setAdding(false);
      return;
    }
    if (path in files) {
      toast('That file already exists', 'error');
      return;
    }
    setFiles((f) => ({ ...f, [path]: '' }));
    setSelected(path);
    setNewPath('');
    setAdding(false);
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

  function collapseAll() {
    setCollapsed(
      new Set(
        Object.keys(files)
          .filter((p) => p.includes('/'))
          .map((p) => p.slice(0, p.indexOf('/')))
      )
    );
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
    if (await save()) {
      toast('Draft saved', 'ok');
      void runPreview(files);
    }
  }

  async function publish() {
    if (Object.keys(files).length === 0) {
      toast('Add a file before publishing', 'error');
      return;
    }
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
  const allPaths = Object.keys(files);
  const shown = filter
    ? allPaths.filter((p) => p.toLowerCase().includes(filter.toLowerCase()))
    : allPaths;
  const groups = groupByFolder(shown.sort());
  const ready = status === 'ready';

  return (
    <div className={onBack ? 'wb' : 'wb wb-inline'}>
      {/* Title bar: navigation + save/publish (VS Code's menu bar sits here; we keep actions). */}
      <div className="wb-titlebar">
        <div className="wb-title-left">
          {onBack && (
            <button className="btn btn-ghost btn-sm" onClick={onBack}>
              <Icon.back /> Back
            </button>
          )}
          <span className="wb-title-name">
            {store.name} — Theme code {dirty && <span className="wb-dirty">●</span>}
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowPreview((v) => !v)}
            disabled={!ready}
          >
            {showPreview ? 'Hide preview' : 'Show preview'}
          </button>
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

      {status === 'loading' && (
        <div className="wb-center">
          <Spinner />
        </div>
      )}

      {status === 'disabled' && (
        <div className="wb-center">
          <EmptyState emoji="🔒" title="Theme code editing isn't enabled here">
            This environment has no theme bundle store configured. Set <code>BUNDLE_S3_BUCKET</code>{' '}
            (and its S3 credentials) on the admin API to edit theme code.
          </EmptyState>
        </div>
      )}

      {status === 'error' && (
        <div className="wb-center">
          <EmptyState emoji="⚠️" title="Couldn't load the theme">
            <p className="muted">{errMsg}</p>
            <button className="btn btn-sm" onClick={load}>
              Retry
            </button>
          </EmptyState>
        </div>
      )}

      {ready && (
        <>
          <div className="wb-body">
            {/* Activity bar */}
            <div className="wb-activitybar">
              <button
                className={showExplorer ? 'active' : ''}
                title="Explorer"
                aria-label="Explorer"
                onClick={() => setShowExplorer((v) => !v)}
              >
                <Icon.files size={22} />
              </button>
              <button
                className={showSearch ? 'active' : ''}
                title="Search files"
                aria-label="Search files"
                onClick={() => setShowSearch((v) => !v)}
              >
                <Icon.search size={22} />
              </button>
            </div>

            {/* Explorer */}
            {showExplorer && (
              <aside className="wb-sidebar">
                <div className="wb-sidebar-title">
                  <span>Explorer</span>
                </div>
                <div className="wb-ws">
                  <span className="wb-ws-name">{store.name}</span>
                  <div className="wb-ws-actions">
                    <button
                      className="btn-icon"
                      title="New file"
                      aria-label="New file"
                      onClick={() => {
                        setAdding(true);
                        setNewPath('');
                      }}
                    >
                      <Icon.newFile size={15} />
                    </button>
                    <button
                      className="btn-icon"
                      title="Collapse folders"
                      aria-label="Collapse folders"
                      onClick={collapseAll}
                    >
                      <Icon.collapseAll size={15} />
                    </button>
                  </div>
                </div>

                {showSearch && (
                  <input
                    className="input wb-search"
                    placeholder="Filter files…"
                    value={filter}
                    autoFocus
                    onChange={(e) => setFilter(e.target.value)}
                  />
                )}

                <div className="wb-tree">
                  {shown.length === 0 ? (
                    <div className="muted tree-empty">{filter ? 'No matches' : 'No files yet'}</div>
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
                                {g.files.map((f) => {
                                  const glyph = fileGlyph(f.path);
                                  return (
                                    <li
                                      key={f.path}
                                      className={f.path === selected ? 'active' : ''}
                                    >
                                      <button
                                        className="tree-item"
                                        onClick={() => setSelected(f.path)}
                                      >
                                        <span className={`fi ${glyph.cls}`}>{glyph.text}</span>
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
                                  );
                                })}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {adding && (
                    <div className="wb-add">
                      <input
                        className="input"
                        placeholder="sections/new.liquid"
                        value={newPath}
                        autoFocus
                        onChange={(e) => setNewPath(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addFile();
                          if (e.key === 'Escape') {
                            addCancelled.current = true;
                            setAdding(false);
                          }
                        }}
                        onBlur={addFile}
                      />
                    </div>
                  )}
                </div>
              </aside>
            )}

            {/* Editor + preview */}
            <div className="wb-main">
              <div className="wb-editor">
                {selected && files[selected] !== undefined ? (
                  <CodeEditor
                    path={selected}
                    initialValue={files[selected]}
                    onChange={(v) => editFile(selected, v)}
                  />
                ) : (
                  <div className="wb-welcome">
                    <div className="wb-welcome-mark">{'</>'}</div>
                    <p>Select a file from the Explorer to start editing.</p>
                    <p className="muted">
                      Your theme lives in <code>layout/</code>, <code>templates/</code>, and{' '}
                      <code>sections/</code>. Edits preview live and go live on Publish.
                    </p>
                  </div>
                )}
              </div>

              {showPreview && (
                <div className="wb-preview">
                  <div className="wb-preview-bar">
                    <span className="muted">Preview{previewing ? ' · rendering…' : ''}</span>
                    <button
                      className="btn-icon"
                      aria-label="Refresh preview"
                      title="Refresh preview"
                      onClick={() => runPreview(files)}
                      disabled={previewing}
                    >
                      <Icon.refresh size={15} />
                    </button>
                  </div>
                  {previewErr ? (
                    <div className="wb-preview-error">{previewErr}</div>
                  ) : (
                    <iframe
                      className="wb-preview-frame"
                      title="Theme preview"
                      sandbox=""
                      srcDoc={previewHtml}
                    />
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Status bar */}
          <div className="wb-statusbar">
            <span className="wb-status-item">● {store.name}</span>
            <span style={{ flex: 1 }} />
            {selected && <span className="wb-status-item">{languageLabel(selected)}</span>}
          </div>
        </>
      )}
    </div>
  );
}
