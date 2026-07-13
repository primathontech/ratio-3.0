import { useCallback, useEffect, useMemo, useState } from 'react';
import { SignedIn, SignedOut, SignIn, UserButton, useAuth } from '@clerk/clerk-react';
import { createApi, type Api, type Store, type PageSummary } from './api';

const API_URL = import.meta.env.VITE_ADMIN_API_URL || 'http://localhost:8787';

export function App() {
  return (
    <div className="app">
      <header>
        <span className="brand">Ratio Admin</span>
        <SignedIn>
          <UserButton />
        </SignedIn>
      </header>
      <SignedOut>
        <div className="center">
          <SignIn routing="hash" />
        </div>
      </SignedOut>
      <SignedIn>
        <Dashboard />
      </SignedIn>
    </div>
  );
}

function Dashboard() {
  const { getToken } = useAuth();
  const api = useMemo<Api>(() => createApi(API_URL, () => getToken()), [getToken]);
  const [selected, setSelected] = useState<Store | null>(null);
  return selected ? (
    <PageManager api={api} store={selected} onBack={() => setSelected(null)} />
  ) : (
    <StoreList api={api} onOpen={setSelected} />
  );
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    fn()
      .then(setData)
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

function StoreList({ api, onOpen }: { api: Api; onOpen: (s: Store) => void }) {
  const { data: stores, error, reload } = useAsync(() => api.listStores(), [api]);
  const [form, setForm] = useState({ id: '', name: '', host: '', color: '#333333' });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api.createStore(form);
      setForm({ id: '', name: '', host: '', color: '#333333' });
      reload();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Your stores</h1>
      {error && <p className="error">{error}</p>}
      <ul className="stores">
        {(stores ?? []).map((s) => (
          <li key={s.id}>
            <button className="link" onClick={() => onOpen(s)}>
              {s.name}
            </button>
            <span className="muted">
              {s.id} · {s.role}
            </span>
          </li>
        ))}
        {stores && stores.length === 0 && <li className="muted">No stores yet.</li>}
      </ul>

      <h2>Create a store</h2>
      <form onSubmit={create} className="form">
        <input
          placeholder="id (e.g. t_acme)"
          value={form.id}
          onChange={(e) => setForm({ ...form, id: e.target.value })}
          required
        />
        <input
          placeholder="name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <input
          placeholder="host (e.g. acme.ratiodev.in)"
          value={form.host}
          onChange={(e) => setForm({ ...form, host: e.target.value })}
          required
        />
        <input
          type="color"
          value={form.color}
          onChange={(e) => setForm({ ...form, color: e.target.value })}
        />
        <button disabled={busy} type="submit">
          {busy ? 'Creating…' : 'Create'}
        </button>
      </form>
      {formError && <p className="error">{formError}</p>}
    </main>
  );
}

function PageManager({ api, store, onBack }: { api: Api; store: Store; onBack: () => void }) {
  const { data: pages, error } = useAsync(() => api.listPages(store.id), [api, store.id]);
  const [path, setPath] = useState('/');
  const [pageType, setPageType] = useState('home');
  const [config, setConfig] = useState('{\n  "sections": []\n}');
  const [status, setStatus] = useState<string | null>(null);

  async function load(p: string) {
    setStatus(null);
    try {
      const page = await api.getPage(store.id, p);
      setPath(page.path);
      setPageType(page.pageType);
      setConfig(JSON.stringify(page.pageConfig, null, 2));
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    let pageConfig: unknown;
    try {
      pageConfig = JSON.parse(config);
    } catch {
      setStatus('pageConfig is not valid JSON');
      return;
    }
    try {
      await api.savePage(store.id, { path, pageType, pageConfig });
      setStatus('Saved — live on the storefront.');
    } catch (err) {
      setStatus((err as Error).message);
    }
  }

  return (
    <main>
      <button className="link" onClick={onBack}>
        ← stores
      </button>
      <h1>{store.name}</h1>
      {error && <p className="error">{error}</p>}
      <ul className="pages">
        {(pages ?? []).map((p: PageSummary) => (
          <li key={p.path}>
            <button className="link" onClick={() => load(p.path)}>
              {p.path}
            </button>
            <span className="muted">{p.page_type}</span>
          </li>
        ))}
      </ul>

      <h2>Edit page</h2>
      <form onSubmit={save} className="form">
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path" />
        <input
          value={pageType}
          onChange={(e) => setPageType(e.target.value)}
          placeholder="page type"
        />
        <textarea rows={16} value={config} onChange={(e) => setConfig(e.target.value)} />
        <button type="submit">Save</button>
      </form>
      {status && <p className={status.startsWith('Saved') ? 'ok' : 'error'}>{status}</p>}
    </main>
  );
}
