import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SignedIn, SignedOut, SignIn, UserButton, useAuth } from '@clerk/clerk-react';
import {
  createApi,
  ApiError,
  type Api,
  type Store,
  type PageSummary,
  type DomainInfo,
  type DomainConnection,
  type AuditEntry,
  type AssistantAction,
} from './api';
import { useTheme } from './theme';
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorBoundary,
  Field,
  Icon,
  Spinner,
  ToastProvider,
  useToast,
} from './ui';
import { SectionEditor, toEditable, type Section } from './sections';

const API_URL = import.meta.env.VITE_ADMIN_API_URL || 'http://localhost:8787';

// Screen-reader-only cue for links that open a new tab (L4 / WCAG G201).
const NewTabHint = () => <span className="sr-only"> (opens in a new tab)</span>;

export function App() {
  const { resolved, cycle } = useTheme();
  return (
    <ToastProvider>
      <header className="appbar">
        <a className="brand" href="/">
          <span className="logo">R</span> Ratio Admin
        </a>
        <div className="right">
          <button
            className="icon-btn"
            onClick={cycle}
            aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`}
            title="Toggle theme"
          >
            {resolved === 'dark' ? <Icon.sun /> : <Icon.moon />}
          </button>
          <SignedIn>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
        </div>
      </header>

      <SignedOut>
        <main className="signin-wrap">
          <div className="signin-card">
            <div style={{ textAlign: 'center' }}>
              <h1>Manage your store</h1>
              <p className="muted tagline">
                Sign in to edit your storefront — pages go live the moment you save.
              </p>
            </div>
            <SignIn routing="hash" />
          </div>
        </main>
      </SignedOut>

      <SignedIn>
        <ErrorBoundary>
          <Dashboard />
        </ErrorBoundary>
      </SignedIn>
    </ToastProvider>
  );
}

function useApi(): Api {
  const { getToken } = useAuth();
  return useMemo(() => createApi(API_URL, () => getToken()), [getToken]);
}

function Dashboard() {
  const api = useApi();
  const [store, setStore] = useState<Store | null>(null);
  // Bumped after the AI assistant makes a change, so the active view remounts and reloads.
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <main className="container">
      {store ? (
        // No key here (M2): remounting the open editor on an assistant change discarded the
        // merchant's unsaved edits. The editor keeps its state; a stale save is caught by the
        // page's optimistic-concurrency version check (409 → "reload").
        <PageManager api={api} store={store} onBack={() => setStore(null)} />
      ) : (
        <StoreList key={reloadKey} api={api} onOpen={setStore} />
      )}
      <AssistantPanel
        api={api}
        storeId={store?.id ?? null}
        onChanged={() => setReloadKey((k) => k + 1)}
      />
    </main>
  );
}

// OFCE-400 Model A: chat with the AI assistant right in the dashboard. It drives the same
// control-plane the rest of this UI does (server-side), so anything it does — onboard a
// store, add a page — is real and shows up in "Recent changes". Available whether or not a
// store is open; when one is open its id is passed so "add a page" needs no repetition.
function AssistantPanel({
  api,
  storeId,
  onChanged,
}: {
  api: Api;
  storeId: string | null;
  onChanged: () => void;
}) {
  type Turn = { role: 'you' | 'ai'; text: string; actions?: AssistantAction[] };
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setErr(null);
    setTurns((t) => [...t, { role: 'you', text }]);
    setBusy(true);
    try {
      // No client key (R12 M-2): a fresh per-send UUID defeated the server's content-derived
      // dedup, so a resend after a client timeout re-ran the tool loop. Omitting it lets the
      // server key on (user, store, message) so an identical resend dedupes within the window.
      const r = await api.assistant(text, storeId ?? undefined);
      setTurns((t) => [...t, { role: 'ai', text: r.reply, actions: r.actions }]);
      if (r.actions.some((a) => a.ok)) onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card pane" style={{ marginTop: 20 }}>
      <div className="pane-head">
        <h2>AI assistant</h2>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Ask in plain English — “Create a store called Acme at acme.ratiodev.in” or “Add an
        About page”. Changes go live immediately and appear in Recent changes.
      </p>

      {/* Always mounted (M6): a live region must exist before its content changes, or the
          first assistant reply isn't announced to screen readers. */}
      <div
        aria-live="polite"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          margin: turns.length ? '12px 0' : 0,
        }}
      >
        {turns.map((t, i) => (
            <div key={i} className={t.role === 'you' ? 'note' : 'note note-ok'}>
              <strong>{t.role === 'you' ? 'You' : 'Assistant'}:</strong> {t.text}
              {t.actions && t.actions.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {t.actions.map((a, j) => (
                    <span key={j} className={a.ok ? 'badge dot-ok' : 'badge dot-warn'}>
                      {a.tool} {a.ok ? 'done' : 'failed'}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
      </div>

      {err && <div className="note note-error" role="alert">{err}</div>}

      <form onSubmit={send} className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
        <Field label={storeId ? `Message (editing ${storeId})` : 'Message'}>
          <input
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the assistant to onboard or edit a store…"
            disabled={busy}
          />
        </Field>
        <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>
          {busy ? <Spinner /> : <Icon.check />} Send
        </button>
      </form>
    </div>
  );
}

/* Store list ------------------------------------------------------------- */
function StoreList({ api, onOpen }: { api: Api; onOpen: (s: Store) => void }) {
  const toast = useToast();
  const [stores, setStores] = useState<Store[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [me, setMe] = useState<{ userId: string; isPlatformAdmin: boolean } | null>(null);

  // Focus the heading when the list view (re)opens — e.g. returning via "All stores" — so
  // focus isn't dropped to <body> on the transition (M5 / WCAG 2.4.3).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const load = useCallback(() => {
    setError(null);
    api
      .listStores()
      .then(setStores)
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => {
    // Retry once so a transient /me failure doesn't silently strip the admin UI for the whole
    // session (L2); after that, degrade quietly to the non-admin view. Guarded against unmount.
    let cancelled = false;
    const loadMe = (attempt = 0) =>
      api
        .me()
        .then((m) => {
          if (!cancelled) setMe(m);
        })
        .catch(() => {
          if (!cancelled && attempt < 1) loadMe(attempt + 1);
        });
    loadMe();
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1
            ref={headingRef}
            tabIndex={-1}
            style={{ display: 'flex', alignItems: 'center', gap: 10, outline: 'none' }}
          >
            {me?.isPlatformAdmin ? 'All stores' : 'Your stores'}
            {me?.isPlatformAdmin && <Badge accent>Admin · all stores</Badge>}
          </h1>
          <p className="muted">
            {me?.isPlatformAdmin
              ? 'Platform admin — you can manage every store on Ratio.'
              : 'Every store is live at its own domain.'}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon.plus /> New store
        </button>
      </div>

      {error && <div className="note note-error" role="alert">{error}</div>}

      {!stores && !error && (
        <div className="grid" role="status" aria-busy="true">
          <span className="sr-only">Loading stores…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="card store-card">
              <div className="skeleton" style={{ height: 34, width: 34, borderRadius: 9 }} />
              <div className="skeleton" style={{ height: 14, width: '70%' }} />
              <div className="skeleton" style={{ height: 12, width: '55%' }} />
            </div>
          ))}
        </div>
      )}

      {stores && stores.length === 0 && (
        <EmptyState emoji="🏪" title="No stores yet">
          <p className="muted" style={{ maxWidth: 320 }}>
            Create your first store — it goes live instantly at its own subdomain.
          </p>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon.plus /> Create a store
          </button>
        </EmptyState>
      )}

      {stores && stores.length > 0 && (
        <div className="grid">
          {stores.map((s) => (
            <StoreCard key={s.id} store={s} onOpen={() => onOpen(s)} />
          ))}
        </div>
      )}

      {creating && (
        <CreateStoreDialog
          api={api}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            toast('Store created');
            load();
          }}
        />
      )}

      {me && (
        <p className="muted" style={{ marginTop: 32, fontSize: 12.5 }}>
          Signed in · <span className="mono">{me.userId}</span>
        </p>
      )}
    </>
  );
}

// Tolerate the deploy-skew window where the API hasn't shipped `hosts` yet.
function hostsOf(store: Store): string[] {
  return store.hosts ?? (store.host ? [store.host] : []);
}

function StoreCard({ store, onOpen }: { store: Store; onOpen: () => void }) {
  const hosts = hostsOf(store);
  return (
    <div className="card store-card">
      <div className="top">
        <div>
          {/* The store name is the primary action (a real button — keyboard/SR correct);
              host links are siblings, not nested inside an interactive element (M-2/L-4). */}
          <button type="button" className="name store-open" onClick={onOpen}>
            {store.name}
          </button>
          {hosts.length > 0 ? (
            <div className="hosts">
              {hosts.map((h) => (
                <a key={h} className="host" href={`https://${h}`} target="_blank" rel="noreferrer">
                  {h} <Icon.external size={11} />
                  <NewTabHint />
                </a>
              ))}
            </div>
          ) : (
            <span className="host muted">no domain</span>
          )}
        </div>
      </div>
      <div className="foot">
        <Badge accent>{store.role}</Badge>
        <span className="mono muted" style={{ fontSize: 12 }}>
          {store.id}
        </span>
      </div>
    </div>
  );
}

function CreateStoreDialog({
  api,
  onClose,
  onCreated,
}: {
  api: Api;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [f, setF] = useState({ id: '', name: '', host: '', color: '#4f46e5' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createStore(f);
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Create a store" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="body">
          <div className="row">
            <Field label="Store ID">
              <input className="input mono" placeholder="t_acme" value={f.id} onChange={set('id')} required />
            </Field>
            <Field label="Name">
              <input className="input" placeholder="Acme" value={f.name} onChange={set('name')} required />
            </Field>
          </div>
          <Field label="Domain">
            <input
              className="input"
              placeholder="acme.ratiodev.in"
              value={f.host}
              onChange={set('host')}
              required
            />
          </Field>
          <Field label="Accent colour">
            <input
              className="input"
              type="color"
              value={f.color}
              onChange={set('color')}
              style={{ height: 42, padding: 4 }}
            />
          </Field>
          {err && <div className="note note-error" role="alert">{err}</div>}
        </div>
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : <Icon.plus />} Create store
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* Page manager ----------------------------------------------------------- */
function PageManager({ api, store, onBack }: { api: Api; store: Store; onBack: () => void }) {
  const toast = useToast();
  const hosts = hostsOf(store);
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  const [path, setPath] = useState('/');
  const [pageType, setPageType] = useState('home');
  const [title, setTitle] = useState('');
  const [sections, setSections] = useState<Section[]>([]);
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [rawJson, setRawJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [previewBump, setPreviewBump] = useState(0);
  const [creating, setCreating] = useState(false);
  // Version of the currently-open page (optimistic concurrency, OFCE-409). Sent on save;
  // a stale value → 409 so a second tab / the AI assistant can't be silently clobbered.
  const [version, setVersion] = useState<number | undefined>(undefined);
  // Monotonic load counter (M3): if two openPage calls overlap, only the latest may write state,
  // so a slow earlier response can't overwrite the page the user actually selected.
  const loadSeq = useRef(0);
  // Move focus to the store heading when this view opens so keyboard/SR users aren't dropped
  // to <body> on the transition (M5 / WCAG 2.4.3).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const loadPages = useCallback(() => {
    api.listPages(store.id).then(setPages).catch((e: Error) => setErr(e.message));
  }, [api, store.id]);
  useEffect(loadPages, [loadPages]);

  async function openPage(p: string) {
    setErr(null);
    const seq = ++loadSeq.current;
    try {
      const page = await api.getPage(store.id, p);
      if (seq !== loadSeq.current) return; // a newer openPage superseded this load
      const editable = toEditable(page.pageConfig);
      setPath(page.path);
      setPageType(page.pageType);
      setTitle(editable.title ?? '');
      setSections(editable.sections);
      setVersion(page.version);
      setMode('visual');
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setErr((e as Error).message);
    }
  }

  // Build the pageConfig from whichever editor mode is active.
  function buildConfig(): { pageConfig: unknown } | { error: string } {
    if (mode === 'json') {
      try {
        return { pageConfig: JSON.parse(rawJson) };
      } catch {
        return { error: 'The JSON is not valid.' };
      }
    }
    return { pageConfig: { title: title || undefined, sections } };
  }

  function switchMode(next: 'visual' | 'json') {
    if (next === mode) return;
    if (next === 'json') {
      setRawJson(JSON.stringify({ title: title || undefined, sections }, null, 2));
    } else {
      try {
        const editable = toEditable(JSON.parse(rawJson));
        setTitle(editable.title ?? '');
        setSections(editable.sections);
        setErr(null);
      } catch {
        setErr('Fix the JSON before switching back to the visual editor.');
        return;
      }
    }
    setMode(next);
  }

  async function createPage(newPath: string, newType: string) {
    setCreating(false);
    try {
      await api.savePage(store.id, { path: newPath, pageType: newType, pageConfig: { sections: [] } });
      toast('Page created');
      loadPages();
      openPage(newPath);
    } catch (e) {
      setErr((e as Error).message);
      toast('Create failed', 'error');
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const built = buildConfig();
    if ('error' in built) {
      setErr(built.error);
      return;
    }
    setSaving(true);
    try {
      const saved = await api.savePage(store.id, {
        path,
        pageType,
        pageConfig: built.pageConfig,
        version,
      });
      setVersion(saved.version);
      toast('Saved — live on your store');
      setPreviewBump((n) => n + 1);
      loadPages();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErr('This page changed since you opened it (another tab or the AI assistant saved). Reopen it to get the latest, then re-apply your changes.');
        toast('Save conflict — reload the page', 'error');
      } else {
        setErr((e as Error).message);
        toast('Save failed', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  // Preview via the platform subdomain — it always resolves (wildcard); a BYO custom
  // domain may not be connected yet. Cache-busted so it shows the just-saved content.
  const previewHost = hosts.find((h) => h.endsWith('.ratiodev.in')) ?? hosts[0] ?? null;
  const previewSrc = previewHost
    ? `https://${previewHost}${path}?_ratiopreview=${previewBump}`
    : null;

  return (
    <>
      <button className="btn btn-subtle crumb" onClick={onBack}>
        <Icon.back size={15} /> All stores
      </button>
      <div className="page-head">
        <div>
          <h1 ref={headingRef} tabIndex={-1} style={{ outline: 'none' }}>
            {store.name}
          </h1>
          {hosts.length > 0 && (
            <p className="hosts">
              {hosts.map((h) => (
                <a key={h} href={`https://${h}`} target="_blank" rel="noreferrer">
                  {h} <Icon.external size={12} />
                  <NewTabHint />
                </a>
              ))}
            </p>
          )}
        </div>
      </div>

      <DomainsPanel api={api} store={store} />

      <AgentAccessPanel api={api} store={store} />

      <AuditPanel api={api} store={store} />

      <div className="editor">
        <div className="card pane">
          <div className="pane-head">
            <h2>Pages</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setCreating(true)}>
              <Icon.plus size={14} /> New page
            </button>
          </div>
          {!pages && <div className="center-pad"><Spinner /></div>}
          {pages && pages.length === 0 && (
            <p className="muted" style={{ padding: '6px 2px' }}>
              No pages yet — create one to get started.
            </p>
          )}
          <nav className="pagelist" aria-label="Pages">
            {pages?.map((p) => (
              <button
                key={p.path}
                className={p.path === path ? 'active' : ''}
                aria-current={p.path === path ? 'true' : undefined}
                onClick={() => openPage(p.path)}
              >
                <span className="mono">{p.path}</span>
                <Badge>{p.page_type}</Badge>
              </button>
            ))}
          </nav>

          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="row">
              <Field label="Path">
                {/* Read-only once a page is loaded (M4): editing the path here would silently
                    save to a different route (duplicate page) while sending this page's version.
                    Renaming is a separate, explicit operation. */}
                <input
                  className="input mono"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  readOnly={version !== undefined}
                  aria-describedby={version !== undefined ? 'path-readonly-hint' : undefined}
                  title={version !== undefined ? 'The path is fixed once a page is loaded' : undefined}
                />
                {version !== undefined && (
                  <span id="path-readonly-hint" className="muted" style={{ fontSize: 11.5 }}>
                    Fixed — create a new page to use a different path.
                  </span>
                )}
              </Field>
              <Field label="Type">
                <input className="input" value={pageType} onChange={(e) => setPageType(e.target.value)} />
              </Field>
            </div>
            <Field label="Page title">
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Shown in the browser tab" />
            </Field>

            <div className="editor-head">
              <span className="field-label">Content</span>
              <div className="seg">
                <button
                  type="button"
                  className={mode === 'visual' ? 'on' : ''}
                  aria-pressed={mode === 'visual'}
                  onClick={() => switchMode('visual')}
                >
                  Visual
                </button>
                <button
                  type="button"
                  className={mode === 'json' ? 'on' : ''}
                  aria-pressed={mode === 'json'}
                  onClick={() => switchMode('json')}
                >
                  JSON
                </button>
              </div>
            </div>

            {mode === 'visual' ? (
              <SectionEditor sections={sections} onChange={setSections} />
            ) : (
              <textarea
                className="textarea"
                value={rawJson}
                onChange={(e) => setRawJson(e.target.value)}
                spellCheck={false}
              />
            )}

            {err && <div className="note note-error" role="alert">{err}</div>}
            <div>
              <button className="btn btn-primary" type="submit" disabled={saving}>
                {saving ? <Spinner /> : <Icon.check />} {saving ? 'Saving…' : 'Save page'}
              </button>
            </div>
          </form>
        </div>

        <div className="card pane">
          <div className="pane-head">
            <h2>Live preview</h2>
            {previewSrc && (
              <a className="btn btn-subtle" href={`https://${previewHost}${path}`} target="_blank" rel="noreferrer">
                Open <Icon.external size={13} />
                <NewTabHint />
              </a>
            )}
          </div>
          {previewSrc ? (
            <>
              <div className="preview-bar mono">
                <span className="dot" /> {previewHost}
                {path}
              </div>
              <iframe
                key={previewBump}
                className="preview-frame"
                src={previewSrc}
                title="Store preview"
                sandbox="allow-same-origin"
              />
            </>
          ) : (
            <EmptyState emoji="🌐" title="No domain yet">
              <p className="muted">Add a domain to this store to see a live preview.</p>
            </EmptyState>
          )}
        </div>
      </div>

      {creating && <NewPageDialog onClose={() => setCreating(false)} onCreate={createPage} />}
    </>
  );
}

function NewPageDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (path: string, type: string) => void;
}) {
  const [p, setP] = useState('/');
  const [t, setT] = useState('page');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog title="New page" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Don't silently no-op on a bad path (L4) — tell the user why nothing happened.
          if (!p.startsWith('/')) {
            setErr('The path must start with a slash, e.g. /about.');
            return;
          }
          onCreate(p, t || 'page');
        }}
      >
        <div className="body">
          {err && <div className="note note-error" role="alert">{err}</div>}
          <Field label="Path (must start with /)">
            <input className="input mono" value={p} onChange={(e) => setP(e.target.value)} placeholder="/about" required />
          </Field>
          <Field label="Type">
            <input className="input" value={t} onChange={(e) => setT(e.target.value)} placeholder="page" />
          </Field>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            <Icon.plus /> Create page
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// Bring-your-own-AI (ADR-007): mint a short-lived key scoped to this store and hand it to
// an AI assistant, which then drives the same control-plane API the dashboard uses.
function AgentAccessPanel({ api, store }: { api: Api; store: Store }) {
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
        carefully. Generating a new key does <strong>not</strong> disable an old one; each
        key stays valid until it expires.
      </p>
      {err && <div className="note note-error" role="alert">{err}</div>}
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

// Recent control-plane changes for this store (ADR-016 audit trail) — makes AI/human edits
// visible and accountable. Every mutation is one row; "AI" = an agent-token actor.
function AuditPanel({ api, store }: { api: Api; store: Store }) {
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
      {err && <div className="note note-error" role="alert">{err}</div>}
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

function DomainsPanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [domains, setDomains] = useState<DomainInfo[] | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null); // host pending confirmation
  const [err, setErr] = useState<string | null>(null);

  // Distinguish a failed load from an empty list (OFCE-414): on error show the error, not
  // a misleading "no domains" state.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    setErr(null);
    const seq = ++loadSeq.current; // latest-wins (M4): a stale response can't re-add a removed domain
    api
      .listDomains(store.id)
      .then((d) => {
        if (seq === loadSeq.current) setDomains(d);
      })
      .catch((e: Error) => {
        if (seq !== loadSeq.current) return;
        setDomains([]);
        setErr(e.message);
      });
  }, [api, store.id]);
  useEffect(load, [load]);

  // Only claim success when the server actually confirms it, and surface real failures
  // (OFCE-414) — no more unconditional "Domain removed".
  async function remove(host: string) {
    setRemoving(null);
    setErr(null);
    try {
      const { removed } = await api.removeDomain(store.id, host);
      toast(removed ? 'Domain removed' : 'Domain was already removed');
      load();
    } catch (e) {
      setErr((e as Error).message);
      toast('Could not remove the domain', 'error');
    }
  }

  const statusBadge = (d: DomainInfo) => {
    if (d.kind === 'platform') return <span className="badge dot-ok">live</span>;
    if (d.status === 'active' && d.sslStatus === 'active') return <span className="badge dot-ok">live</span>;
    if (d.status === 'unconfigured') return <span className="badge">not configured</span>;
    return <span className="badge dot-warn">pending</span>;
  };

  return (
    <div className="card pane domains-panel">
      <div className="pane-head">
        <h2>Domains</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setConnecting(true)}>
          <Icon.plus size={14} /> Connect a domain
        </button>
      </div>
      {err && <div className="note note-error" role="alert">{err}</div>}
      {!domains && !err && <div className="center-pad"><Spinner /></div>}
      <div className="domain-rows">
        {domains?.map((d) => (
          <div className="domain-row" key={d.host}>
            <a className="mono" href={`https://${d.host}`} target="_blank" rel="noreferrer">
              {d.host}
              <NewTabHint />
            </a>
            <span className="badge">{d.kind === 'platform' ? 'Ratio subdomain' : 'custom'}</span>
            {statusBadge(d)}
            {d.kind === 'custom' && (
              <div className="domain-actions">
                <button className="btn btn-subtle btn-sm" onClick={() => setViewing(d.host)}>
                  View DNS records
                </button>
                <button className="icon-btn" aria-label="Remove domain" onClick={() => setRemoving(d.host)}>
                  <Icon.trash size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {connecting && (
        <ConnectDomainDialog api={api} store={store} onClose={() => setConnecting(false)} onDone={() => { setConnecting(false); load(); }} />
      )}
      {viewing && (
        <DomainRecordsDialog api={api} store={store} host={viewing} onClose={() => { setViewing(null); load(); }} />
      )}
      {removing && (
        <Dialog title="Remove this domain?" onClose={() => setRemoving(null)}>
          <div className="body">
            <p>
              Remove <span className="mono">{removing}</span> from this store? The store will
              stop serving on it immediately until you reconnect it.
            </p>
          </div>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={() => remove(removing)}>
              <Icon.trash size={14} /> Remove domain
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// Reused by the connect dialog and the "view records" dialog.
// Copy-to-clipboard button — DNS values (esp. long TXT tokens) are error-prone to hand-type.
function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      aria-label={`Copy ${label}`}
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function DnsRecordsView({ result }: { result: DomainConnection }) {
  if (!result.records || result.records.length === 0) {
    return <div className="note">{result.note || result.error || 'Domain mapped.'}</div>;
  }
  const isApex = result.apex ?? (!!result.host && result.host.split('.').length <= 2);
  return (
    <>
      {isApex && (
        <div className="note note-warn dns-apex">
          <strong>Heads-up: {result.host} is a root (naked) domain.</strong>
          <span>
            Most domain providers (GoDaddy, Namecheap, …) can&apos;t point a root domain straight at
            us.
          </span>
          <span>
            <strong>Recommended:</strong> connect <span className="mono">www.{result.host}</span>{' '}
            instead, then set your root <span className="mono">{result.host}</span> to{' '}
            <em>forward / redirect</em> to <span className="mono">https://www.{result.host}</span>.
          </span>
          <span className="muted">
            Advanced: if your provider supports ALIAS/ANAME or CNAME-flattening (e.g. Cloudflare),
            you can use the routing record below at the root instead. Either way, the{' '}
            <span className="mono">TXT</span> records below still apply.
          </span>
        </div>
      )}
      <p className="dns-intro">
        Add these records at your domain provider for <span className="mono">{result.host}</span>.{' '}
        <em>Host/Name</em> is the part before your domain (the middle column) — use <strong>Copy</strong>{' '}
        so values paste in exactly.
      </p>
      <table className="dns-table">
        <colgroup>
          <col style={{ width: '62px' }} />
          <col />
          <col style={{ width: '42%' }} />
          <col style={{ width: '52px' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Host / Name</th>
            <th scope="col">Value</th>
            <th scope="col">TTL</th>
          </tr>
        </thead>
        <tbody>
          {result.records.map((r, i) => (
            <Fragment key={i}>
              {r.purpose && (
                <tr className="dns-step-row">
                  <td className="dns-step" colSpan={4}>
                    {r.purpose}
                  </td>
                </tr>
              )}
              <tr className="dns-data-row">
                <td>
                  <span className="badge">{r.type}</span>
                </td>
                <td className="mono dns-host">
                  <span className="dns-cell">
                    <span className="dns-cell-text">{r.host}</span>
                    <CopyBtn text={r.host} label="host" />
                  </span>
                </td>
                <td className="mono dns-val">
                  <span className="dns-cell">
                    <span className="dns-cell-text">{r.value}</span>
                    <CopyBtn text={r.value} label="value" />
                  </span>
                </td>
                <td className="muted">{r.ttl}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}

function DomainRecordsDialog({
  api,
  store,
  host,
  onClose,
}: {
  api: Api;
  store: Store;
  host: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<DomainConnection | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .getDomain(store.id, host)
      .then(setResult)
      .catch((e: Error) => setErr(e.message));
  }, [api, store.id, host]);
  return (
    <Dialog title={`DNS records — ${host}`} onClose={onClose} size="wide">
      <div className="body">
        {err && <div className="note note-error" role="alert">{err}</div>}
        {!result && !err && <div className="center-pad"><Spinner /></div>}
        {result && (
          <>
            {result.status && (
              <div className={result.status === 'active' ? 'note note-ok dns-status' : 'note dns-status'}>
                {result.status === 'active'
                  ? '✓ Live — your domain is connected and serving.'
                  : 'Waiting on your DNS. Add the records below; once they propagate we verify ownership and issue the SSL certificate automatically — usually 5–30 minutes, occasionally a few hours.'}
              </div>
            )}
            <DnsRecordsView result={result} />
          </>
        )}
      </div>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          <Icon.check /> Done
        </button>
      </div>
    </Dialog>
  );
}

function ConnectDomainDialog({
  api,
  store,
  onClose,
  onDone,
}: {
  api: Api;
  store: Store;
  onClose: () => void;
  onDone: () => void;
}) {
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<DomainConnection | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.connectDomain(store.id, host.trim().toLowerCase()));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Connect a custom domain" onClose={onClose}>
      {!result ? (
        <form onSubmit={submit}>
          <div className="body">
            <Field label="Your domain">
              <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="shop.yourbrand.com" required />
            </Field>
            <p className="muted" style={{ fontSize: 12.5 }}>
              We'll issue an SSL certificate and give you the exact DNS records to add at your registrar.
            </p>
            {err && <div className="note note-error" role="alert">{err}</div>}
          </div>
          <div className="actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Spinner /> : <Icon.plus />} Connect
            </button>
          </div>
        </form>
      ) : (
        <div>
          <div className="body">
            <DnsRecordsView result={result} />
          </div>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={onDone}>
              <Icon.check /> Done
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
