import { useCallback, useEffect, useMemo, useState } from 'react';
import { SignedIn, SignedOut, SignIn, UserButton, useAuth } from '@clerk/clerk-react';
import { createApi, type Api, type Store, type PageSummary } from './api';
import { useTheme } from './theme';
import { Badge, Dialog, EmptyState, Field, Icon, Spinner, ToastProvider, useToast } from './ui';

const API_URL = import.meta.env.VITE_ADMIN_API_URL || 'http://localhost:8787';

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
        <div className="signin-wrap">
          <div className="signin-card">
            <div style={{ textAlign: 'center' }}>
              <h1>Manage your store</h1>
              <p className="muted tagline">
                Sign in to edit your storefront — pages go live the moment you save.
              </p>
            </div>
            <SignIn routing="hash" />
          </div>
        </div>
      </SignedOut>

      <SignedIn>
        <Dashboard />
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
  return (
    <main className="container">
      {store ? (
        <PageManager api={api} store={store} onBack={() => setStore(null)} />
      ) : (
        <StoreList api={api} onOpen={setStore} />
      )}
    </main>
  );
}

/* Store list ------------------------------------------------------------- */
function StoreList({ api, onOpen }: { api: Api; onOpen: (s: Store) => void }) {
  const toast = useToast();
  const [stores, setStores] = useState<Store[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .listStores()
      .then(setStores)
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(load, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Your stores</h1>
          <p className="muted">Every store is live at its own domain.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon.plus /> New store
        </button>
      </div>

      {error && <div className="note note-error">{error}</div>}

      {!stores && !error && (
        <div className="grid">
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
    </>
  );
}

function StoreCard({ store, onOpen }: { store: Store; onOpen: () => void }) {
  return (
    <div className="card store-card" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}>
      <div className="top">
        <span className="swatch" style={{ background: 'var(--surface-2)' }} />
        <div>
          <div className="name">{store.name}</div>
          {store.host ? (
            <a
              className="host"
              href={`https://${store.host}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {store.host} <Icon.external size={11} />
            </a>
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
          {err && <div className="note note-error">{err}</div>}
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
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  const [path, setPath] = useState('/');
  const [pageType, setPageType] = useState('home');
  const [config, setConfig] = useState('{\n  "sections": []\n}');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [previewBump, setPreviewBump] = useState(0);

  const loadPages = useCallback(() => {
    api.listPages(store.id).then(setPages).catch((e: Error) => setErr(e.message));
  }, [api, store.id]);
  useEffect(loadPages, [loadPages]);

  async function openPage(p: string) {
    setErr(null);
    try {
      const page = await api.getPage(store.id, p);
      setPath(page.path);
      setPageType(page.pageType);
      setConfig(JSON.stringify(page.pageConfig, null, 2));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    let pageConfig: unknown;
    try {
      pageConfig = JSON.parse(config);
    } catch {
      setErr('The page config is not valid JSON.');
      return;
    }
    setSaving(true);
    try {
      await api.savePage(store.id, { path, pageType, pageConfig });
      toast('Saved — live on your store');
      setPreviewBump((n) => n + 1);
      loadPages();
    } catch (e) {
      setErr((e as Error).message);
      toast('Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  // Cache-busted so the preview reflects the just-saved content (bypasses edge cache).
  const previewSrc = store.host
    ? `https://${store.host}${path}?_ratiopreview=${previewBump}`
    : null;

  return (
    <>
      <button className="btn btn-subtle crumb" onClick={onBack}>
        <Icon.back size={15} /> All stores
      </button>
      <div className="page-head">
        <div>
          <h1>{store.name}</h1>
          {store.host && (
            <p>
              <a href={`https://${store.host}`} target="_blank" rel="noreferrer">
                {store.host} <Icon.external size={12} />
              </a>
            </p>
          )}
        </div>
      </div>

      <div className="editor">
        <div className="card pane">
          <div className="pane-head">
            <h2>Pages</h2>
          </div>
          {!pages && <div className="center-pad"><Spinner /></div>}
          <div className="pagelist">
            {pages?.map((p) => (
              <button
                key={p.path}
                className={p.path === path ? 'active' : ''}
                onClick={() => openPage(p.path)}
              >
                <span className="mono">{p.path}</span>
                <Badge>{p.page_type}</Badge>
              </button>
            ))}
          </div>

          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="row">
              <Field label="Path">
                <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} />
              </Field>
              <Field label="Type">
                <input className="input" value={pageType} onChange={(e) => setPageType(e.target.value)} />
              </Field>
            </div>
            <Field label="Content (JSON)">
              <textarea className="textarea" value={config} onChange={(e) => setConfig(e.target.value)} spellCheck={false} />
            </Field>
            {err && <div className="note note-error">{err}</div>}
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
              <a className="btn btn-subtle" href={`https://${store.host}${path}`} target="_blank" rel="noreferrer">
                Open <Icon.external size={13} />
              </a>
            )}
          </div>
          {previewSrc ? (
            <>
              <div className="preview-bar mono">
                <span className="dot" /> {store.host}
                {path}
              </div>
              <iframe
                key={previewBump}
                className="preview-frame"
                src={previewSrc}
                title="Store preview"
              />
            </>
          ) : (
            <EmptyState emoji="🌐" title="No domain yet">
              <p className="muted">Add a domain to this store to see a live preview.</p>
            </EmptyState>
          )}
        </div>
      </div>
    </>
  );
}
