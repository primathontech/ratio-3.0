import { useCallback, useEffect, useMemo, useState } from 'react';
import { SignedIn, SignedOut, SignIn, UserButton, useAuth } from '@clerk/clerk-react';
import {
  createApi,
  type Api,
  type Store,
  type PageSummary,
  type DomainInfo,
  type DomainConnection,
} from './api';
import { useTheme } from './theme';
import { Badge, Dialog, EmptyState, Field, Icon, Spinner, ToastProvider, useToast } from './ui';
import { SectionEditor, toEditable, type Section } from './sections';

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
  const [me, setMe] = useState<{ userId: string; isPlatformAdmin: boolean } | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .listStores()
      .then(setStores)
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => {
    api.me().then(setMe).catch(() => {});
  }, [api]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
    <div className="card store-card" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}>
      <div className="top">
        <span className="swatch" style={{ background: 'var(--surface-2)' }} />
        <div>
          <div className="name">{store.name}</div>
          {hosts.length > 0 ? (
            <div className="hosts">
              {hosts.map((h) => (
                <a
                  key={h}
                  className="host"
                  href={`https://${h}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  {h} <Icon.external size={11} />
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

  const loadPages = useCallback(() => {
    api.listPages(store.id).then(setPages).catch((e: Error) => setErr(e.message));
  }, [api, store.id]);
  useEffect(loadPages, [loadPages]);

  async function openPage(p: string) {
    setErr(null);
    try {
      const page = await api.getPage(store.id, p);
      const editable = toEditable(page.pageConfig);
      setPath(page.path);
      setPageType(page.pageType);
      setTitle(editable.title ?? '');
      setSections(editable.sections);
      setMode('visual');
    } catch (e) {
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
      await api.savePage(store.id, { path, pageType, pageConfig: built.pageConfig });
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
          <h1>{store.name}</h1>
          {hosts.length > 0 && (
            <p className="hosts">
              {hosts.map((h) => (
                <a key={h} href={`https://${h}`} target="_blank" rel="noreferrer">
                  {h} <Icon.external size={12} />
                </a>
              ))}
            </p>
          )}
        </div>
      </div>

      <DomainsPanel api={api} store={store} />

      <div className="editor">
        <div className="card pane">
          <div className="pane-head">
            <h2>Pages</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => setCreating(true)}>
              <Icon.plus size={14} /> New page
            </button>
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
            <Field label="Page title">
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Shown in the browser tab" />
            </Field>

            <div className="editor-head">
              <span className="field-label">Content</span>
              <div className="seg">
                <button type="button" className={mode === 'visual' ? 'on' : ''} onClick={() => switchMode('visual')}>
                  Visual
                </button>
                <button type="button" className={mode === 'json' ? 'on' : ''} onClick={() => switchMode('json')}>
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
              <a className="btn btn-subtle" href={`https://${previewHost}${path}`} target="_blank" rel="noreferrer">
                Open <Icon.external size={13} />
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
  return (
    <Dialog title="New page" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (p.startsWith('/')) onCreate(p, t || 'page');
        }}
      >
        <div className="body">
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

function DomainsPanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [domains, setDomains] = useState<DomainInfo[] | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listDomains(store.id).then(setDomains).catch(() => setDomains([]));
  }, [api, store.id]);
  useEffect(load, [load]);

  async function remove(host: string) {
    await api.removeDomain(store.id, host).catch(() => {});
    toast('Domain removed');
    load();
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
      {!domains && <div className="center-pad"><Spinner /></div>}
      <div className="domain-rows">
        {domains?.map((d) => (
          <div className="domain-row" key={d.host}>
            <a className="mono" href={`https://${d.host}`} target="_blank" rel="noreferrer">
              {d.host}
            </a>
            <span className="badge">{d.kind === 'platform' ? 'Ratio subdomain' : 'custom'}</span>
            {statusBadge(d)}
            {d.kind === 'custom' && (
              <div className="domain-actions">
                <button className="btn btn-subtle btn-sm" onClick={() => setViewing(d.host)}>
                  View DNS records
                </button>
                <button className="icon-btn" aria-label="Remove domain" onClick={() => remove(d.host)}>
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
    </div>
  );
}

// Reused by the connect dialog and the "view records" dialog.
function DnsRecordsView({ result }: { result: DomainConnection }) {
  if (!result.records || result.records.length === 0) {
    return <div className="note">{result.note || result.error || 'Domain mapped.'}</div>;
  }
  return (
    <>
      <p style={{ fontSize: 13 }}>
        Add these records at your DNS provider for <span className="mono">{result.host}</span>. It goes live
        once they propagate and the certificate issues.
      </p>
      <div className="dns-records">
        {result.records.map((r, i) => (
          <div className="dns-record" key={i}>
            <span className="badge">{r.type}</span>
            <div className="dns-kv">
              <div className="mono dns-name">{r.name}</div>
              <div className="mono dns-val">{r.value}</div>
              <div className="muted">{r.purpose}</div>
            </div>
          </div>
        ))}
      </div>
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
    <Dialog title={`DNS records — ${host}`} onClose={onClose}>
      <div className="body">
        {err && <div className="note note-error">{err}</div>}
        {!result && !err && <div className="center-pad"><Spinner /></div>}
        {result && (
          <>
            {result.status && (
              <p className="muted" style={{ fontSize: 12.5 }}>
                Status: <strong>{result.status}</strong>
                {result.sslStatus ? ` · SSL: ${result.sslStatus}` : ''}
              </p>
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
            {err && <div className="note note-error">{err}</div>}
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
