import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  canManageStore,
  type Api,
  type Store,
  type ThemeFiles,
  type ThemeVersion,
} from '../../common/api';
import { Dialog, EmptyState, Icon, Spinner, useToast } from '../../common/ui';
import { storefrontUrl } from '../../common/store-context';
import { CodeEditor } from './code-editor';
import { groupByFolder, languageLabel, THEME_FOLDERS } from './editor-helpers';
import { EditorTitleBar } from './editor-titlebar';
import { EditorExplorer } from './editor-explorer';
import { EditorTabs } from './editor-tabs';
import { EditorPreview } from './editor-preview';
import { EditorVersions } from './editor-versions';
import './theme-editor.css';

type Status = 'loading' | 'ready' | 'disabled' | 'error';

// The merchant theme code editor (OFCE-601): a VS Code-style workbench — activity bar, Explorer, Monaco
// editor, live preview, status bar — over the store's working bundle theme. This is the container: it
// owns all state and handlers and composes the presentational pieces (title bar, explorer, tabs,
// preview) from ./editor-*. `onBack` renders it as a full-screen route; without it, inline.
export function ThemeCodeEditor({
  api,
  store,
  themeId,
  isLocal,
  onBack,
}: {
  api: Api;
  store: Store;
  themeId: string;
  isLocal: boolean;
  onBack?: () => void;
}) {
  const toast = useToast();
  const [files, setFiles] = useState<ThemeFiles>({});
  // The draft revision last loaded/saved — round-tripped on save so the server rejects (409) a write
  // that would clobber another editor's newer save. A ref, not state: it never drives rendering.
  const revisionRef = useRef<string>('');
  const [selected, setSelected] = useState<string | null>(null);
  // Files open as tabs, in the order they were opened.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  // VS Code-style preview tab: opening a file from the tree reuses this single ephemeral slot instead
  // of piling up tabs. It becomes permanent (leaves the slot) when double-clicked or edited. null =
  // no ephemeral tab open.
  const [previewTab, setPreviewTab] = useState<string | null>(null);
  // Tree selection is single: either the open file OR a folder the user clicked — never both, and no
  // folder is selected by default. null = the open file is the highlighted row.
  const [folderSel, setFolderSel] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // All folders start collapsed (like Shopify's theme editor); the user expands what they need.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(THEME_FOLDERS));
  const [filter, setFilter] = useState('');
  // Activity bar: one view active at a time, or none — which collapses the sidebar (VS Code-style).
  const [activeView, setActiveView] = useState<'explorer' | 'search' | null>('explorer');
  const [showPreview, setShowPreview] = useState(false);
  // Published version history + which version is live (the title-bar indicator + the versions drawer).
  const [versions, setVersions] = useState<ThemeVersion[]>([]);
  const [liveVersion, setLiveVersion] = useState<number | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewErr, setPreviewErr] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewPage, setPreviewPage] = useState('index');
  // Set when the new-file input is cancelled (Escape), so the unmount-triggered blur doesn't re-create
  // the file the user just cancelled.
  const addCancelled = useRef(false);
  const canPublish = canManageStore(store);
  // Where a new file lands: the selected folder, or the open file's folder, else null (root — the
  // input then takes a full path). Lets "New file" drop the input right inside that folder.
  const targetFolder =
    folderSel ??
    (selected && selected.includes('/') ? selected.slice(0, selected.indexOf('/')) : null);

  // Open a file from the tree: activate it if already open, otherwise show it in the single preview
  // slot, replacing whatever ephemeral tab was there (so tree browsing doesn't pile up tabs).
  function openFile(path: string) {
    setFolderSel(null); // opening a file moves the single tree selection off any folder
    setSelected(path);
    if (openTabs.includes(path)) return;
    setOpenTabs((tabs) =>
      previewTab && tabs.includes(previewTab)
        ? tabs.map((p) => (p === previewTab ? path : p))
        : [...tabs, path]
    );
    setPreviewTab(path);
  }

  // Pin a tab so it stays open (double-click on the tab, or editing the file) — it leaves the preview
  // slot and behaves like a normal tab until closed.
  function pinTab(path: string) {
    setPreviewTab((prev) => (prev === path ? null : prev));
  }

  // Close a tab; if it was the active one, fall back to its neighbour (or nothing).
  function closeTab(path: string) {
    const idx = openTabs.indexOf(path);
    const next = openTabs.filter((p) => p !== path);
    setOpenTabs(next);
    setPreviewTab((prev) => (prev === path ? null : prev));
    if (selected === path) {
      setSelected(next.length ? next[Math.min(idx, next.length - 1)] : null);
    }
  }

  function toggleFolder(folder: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  // Clicking a folder selects it (highlight) and toggles it open/closed — this also clears the file
  // highlight, so only one row is ever selected.
  function selectFolder(folder: string) {
    setFolderSel(folder);
    toggleFolder(folder);
  }

  // Render the given files server-side (the storefront's own render path) into the preview iframe.
  const runPreview = useCallback(
    async (f: ThemeFiles, page: string) => {
      setPreviewing(true);
      try {
        const res = await api.previewBundle(store.id, themeId, f, page);
        setPreviewErr(res.error ?? '');
        setPreviewHtml(res.error ? '' : (res.html ?? ''));
      } catch (e) {
        setPreviewErr(e instanceof Error ? e.message : 'Preview failed');
        setPreviewHtml('');
      } finally {
        setPreviewing(false);
      }
    },
    [api, store.id, themeId]
  );

  const load = useCallback(() => {
    setStatus('loading');
    api
      .getBundleDraft(store.id, themeId)
      // A brand-new store has no theme files yet — seed a default starter so the editor opens with a
      // working folder structure instead of empty. The seed is persisted server-side (not a dirty edit).
      .then((d) =>
        Object.keys(d.files).length === 0 ? api.scaffoldBundleDraft(store.id, themeId) : d
      )
      .then((d) => {
        // Start with no file open — the editor shows the welcome panel until the user picks a file.
        setFiles(d.files);
        revisionRef.current = d.revision;
        setStatus('ready');
        void runPreview(d.files, 'index');
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 503) {
          setStatus('disabled');
          return;
        }
        setErrMsg(e instanceof Error ? e.message : 'Could not load the theme');
        setStatus('error');
      });
  }, [api, store.id, themeId, runPreview]);
  useEffect(load, [load]);

  // Published version history + the live pointer. Non-fatal: a failed fetch just leaves the drawer
  // empty and the indicator at "Not published yet" — the editor itself still works.
  const loadVersions = useCallback(async () => {
    setVersionsLoading(true);
    try {
      const v = await api.bundleVersions(store.id, themeId);
      setVersions(v.versions);
      setLiveVersion(v.liveVersion);
    } catch {
      // ignore — the history panel is optional; editing/saving don't depend on it
    } finally {
      setVersionsLoading(false);
    }
  }, [api, store.id, themeId]);
  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  // Leaving the Search view drops the filter, so the Explorer never shows a filtered tree with no
  // visible search box.
  useEffect(() => {
    if (activeView !== 'search' && filter) setFilter('');
  }, [activeView, filter]);

  function editFile(path: string, content: string) {
    setFiles((f) => ({ ...f, [path]: content }));
    setDirty(true);
    // Editing a preview tab pins it, so it isn't replaced out from under an unsaved change.
    setPreviewTab((prev) => (prev === path ? null : prev));
  }

  function addFile() {
    if (addCancelled.current) {
      addCancelled.current = false;
      setAdding(false);
      setNewPath('');
      return;
    }
    const name = newPath.trim();
    if (!name) {
      setAdding(false);
      return;
    }
    // Inside a selected folder we know the prefix, so the input took just the filename; at root the
    // user typed the full path.
    const path = targetFolder ? `${targetFolder}/${name}` : name;
    if (path in files) {
      toast('That file already exists', 'error');
      return;
    }
    setFiles((f) => ({ ...f, [path]: '' }));
    // A just-created file opens as a permanent tab (not the ephemeral preview slot).
    setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
    setFolderSel(null);
    setSelected(path);
    setNewPath('');
    setAdding(false);
    setDirty(true);
  }

  function deleteFile(path: string) {
    const idx = openTabs.indexOf(path);
    const nextTabs = openTabs.filter((p) => p !== path);
    setFiles((f) => {
      const next = { ...f };
      delete next[path];
      return next;
    });
    setOpenTabs(nextTabs);
    setPreviewTab((prev) => (prev === path ? null : prev));
    setSelected((s) =>
      s === path ? (nextTabs.length ? nextTabs[Math.min(idx, nextTabs.length - 1)] : null) : s
    );
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
      const res = await api.saveBundleDraft(store.id, themeId, files, revisionRef.current);
      revisionRef.current = res.hash;
      setDirty(false);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Keep the buffer (dirty stays true) so the user can copy their edits out; Refresh replaces it
        // with the latest, so warn before they lose work.
        toast(
          'This theme was changed elsewhere. Copy any edits you want to keep, then Refresh to load the latest.',
          'error'
        );
        return false;
      }
      toast((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (await save()) {
      toast('Draft saved', 'ok');
      void runPreview(files, previewPage);
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
      const res = await api.publishBundle(store.id, themeId);
      toast(`Published theme v${res.version}`, 'ok');
      await loadVersions(); // the live indicator + history now include the new version
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // Drop unsaved edits: reload the saved draft (base ⊕ overrides) via the normal load path. Only the
  // in-memory buffer is discarded — nothing on the server changes.
  function discard() {
    setDirty(false);
    load();
  }

  // Roll the live pointer back to an earlier published version (owner-only). The immutable bundles are
  // all still in S3, so this is an instant pointer move; refetch so the Live badge follows it.
  async function rollback(version: number) {
    setBusy(true);
    try {
      await api.rollbackBundle(store.id, themeId, version);
      toast(`Rolled back to v${version}`, 'ok');
      await loadVersions();
      void runPreview(files, previewPage);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // Reset the draft to pure base — drop ALL saved overrides (destructive). The reply carries the
  // now-composed default files + fresh revision, so we swap the buffer in place (no reload flash).
  async function resetToBase() {
    setConfirmReset(false);
    setBusy(true);
    try {
      const d = await api.resetBundleDraft(store.id, themeId);
      setFiles(d.files);
      revisionRef.current = d.revision;
      setDirty(false);
      toast('Theme reset to the default', 'ok');
      void runPreview(d.files, previewPage);
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
  // Show the full Shopify folder set (empty ones as placeholders) when browsing; while filtering,
  // only show folders that actually contain a match.
  const groups = groupByFolder(shown.sort(), filter ? [] : THEME_FOLDERS);
  // Preview targets = the theme's page templates (templates/<page>.json), home first.
  const templatePages = Object.keys(files)
    .filter((p) => p.startsWith('templates/') && p.endsWith('.json'))
    .map((p) => p.slice('templates/'.length, -'.json'.length))
    .sort((a, b) => (a === 'index' ? -1 : b === 'index' ? 1 : a.localeCompare(b)));
  // If the selected preview page's template was deleted/renamed, fall back to a valid one so the
  // dropdown never shows a blank/invalid selection.
  useEffect(() => {
    if (templatePages.length > 0 && !templatePages.includes(previewPage)) {
      setPreviewPage(templatePages[0]);
    }
  }, [templatePages, previewPage]);
  const ready = status === 'ready';

  return (
    <div className={onBack ? 'wb' : 'wb wb-inline'}>
      <EditorTitleBar
        storeName={store.name}
        dirty={dirty}
        ready={ready}
        busy={busy}
        showPreview={showPreview}
        showVersions={showVersions}
        liveVersion={liveVersion}
        liveUrl={url}
        canPublish={canPublish}
        onBack={onBack}
        onTogglePreview={() => setShowPreview((v) => !v)}
        onToggleVersions={() => setShowVersions((v) => !v)}
        onDiscard={discard}
        onSaveDraft={saveDraft}
        onPublish={publish}
      />

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
                className={activeView === 'explorer' ? 'active' : ''}
                title="Explorer"
                aria-label="Explorer"
                aria-pressed={activeView === 'explorer'}
                onClick={() => setActiveView((v) => (v === 'explorer' ? null : 'explorer'))}
              >
                <Icon.files size={22} />
              </button>
              <button
                className={activeView === 'search' ? 'active' : ''}
                title="Search files"
                aria-label="Search files"
                aria-pressed={activeView === 'search'}
                onClick={() => setActiveView((v) => (v === 'search' ? null : 'search'))}
              >
                <Icon.search size={22} />
              </button>
            </div>

            {activeView && (
              <EditorExplorer
                storeName={store.name}
                groups={groups}
                hasFiles={groups.length > 0}
                filter={filter}
                showSearch={activeView === 'search'}
                onFilterChange={setFilter}
                collapsed={collapsed}
                onFolderClick={selectFolder}
                selected={selected}
                selectedFolder={folderSel}
                targetFolder={targetFolder}
                onSelect={openFile}
                onNewFile={() => {
                  setAdding(true);
                  setNewPath('');
                  // Make sure the target folder is open so the inline input is visible.
                  if (targetFolder) {
                    setCollapsed((c) => {
                      const n = new Set(c);
                      n.delete(targetFolder);
                      return n;
                    });
                  }
                }}
                onRefresh={load}
                onCollapseAll={collapseAll}
                confirmDelete={confirmDelete}
                onRequestDelete={setConfirmDelete}
                onConfirmDelete={(path) => {
                  deleteFile(path);
                  setConfirmDelete(null);
                }}
                onCancelDelete={() => setConfirmDelete(null)}
                adding={adding}
                newPath={newPath}
                onNewPathChange={setNewPath}
                onAddCommit={addFile}
                onAddCancel={() => {
                  addCancelled.current = true;
                  setAdding(false);
                }}
              />
            )}

            {/* Editor + preview */}
            <div className="wb-main">
              <div className="wb-editor">
                <EditorTabs
                  openTabs={openTabs}
                  selected={selected}
                  previewTab={previewTab}
                  onSelect={openFile}
                  onClose={closeTab}
                  onPin={pinTab}
                />
                <div className="wb-editor-body">
                  {selected && files[selected] !== undefined ? (
                    <CodeEditor
                      path={selected}
                      initialValue={files[selected]}
                      onChange={(v) => editFile(selected, v)}
                    />
                  ) : (
                    <div className="wb-welcome">
                      <svg
                        className="wb-welcome-mark"
                        width="52"
                        height="52"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13.5 6l-3 12" />
                      </svg>
                      <p>Select a file from the Explorer to start editing.</p>
                      <p className="muted">
                        Your theme lives in <code>layout/</code>, <code>templates/</code>, and{' '}
                        <code>sections/</code>. Edits preview live and go live on Publish.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {showPreview && (
                <EditorPreview
                  previewing={previewing}
                  previewErr={previewErr}
                  previewHtml={previewHtml}
                  previewPage={previewPage}
                  templatePages={templatePages}
                  onPageChange={(page) => {
                    setPreviewPage(page);
                    void runPreview(files, page);
                  }}
                  onRefresh={() => runPreview(files, previewPage)}
                />
              )}
            </div>

            {showVersions && (
              <EditorVersions
                versions={versions}
                liveVersion={liveVersion}
                loading={versionsLoading}
                canRollback={canPublish}
                busy={busy}
                onRollback={rollback}
                onResetToBase={() => setConfirmReset(true)}
                onClose={() => setShowVersions(false)}
              />
            )}
          </div>

          {/* Status bar */}
          <div className="wb-statusbar">
            <span className="wb-status-item">● {store.name}</span>
            <span style={{ flex: 1 }} />
            {selected && <span className="wb-status-item">{languageLabel(selected)}</span>}
          </div>
        </>
      )}

      {confirmReset && (
        <Dialog title="Reset to the default theme?" onClose={() => setConfirmReset(false)}>
          <p className="muted" style={{ margin: '0 0 16px' }}>
            This removes all your customizations and restores the default theme. It can't be undone.
          </p>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={() => setConfirmReset(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-sm btn-danger" onClick={resetToBase} disabled={busy}>
              Reset to default
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
