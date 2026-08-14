import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SignedIn, SignedOut, SignIn, useAuth } from '@clerk/clerk-react';
import {
  createApi,
  type Api,
  type Store,
  type DomainInfo,
  type DomainConnection,
  type AuditEntry,
  type AssistantAction,
  type ThemeVersion,
} from './common/api';
import {
  Dialog,
  EmptyState,
  ErrorBoundary,
  Field,
  Icon,
  Spinner,
  ToastProvider,
  useToast,
} from './common/ui';
import { PageEditor } from './features/pages/pagebuilder';
import { PagesList } from './features/pages/pages-list';
// Lazy: the code editor pulls in CodeMirror (~200KB) — keep it out of the main bundle so it only
// loads when a merchant actually opens the theme-code route.
const ThemeCodeEditor = lazy(() =>
  import('./features/theme/theme-editor').then((m) => ({ default: m.ThemeCodeEditor }))
);
import { ThemeSettingsPanel } from './features/theme/theme-settings';
import { SuperAdmin } from './features/admin/superadmin';
import { DashboardHome } from './features/dashboard/dashboard';
import { MerchantLayout, PlatformLayout, ComingSoon } from './features/shell/app-shell';
import { AskRatio } from './features/assistant/ask-sophie';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  StoreDataProvider,
  storeSlug,
  resolveStore,
  useMerchant,
  useStoreData,
  type Me,
} from './common/store-context';

const API_URL = import.meta.env.VITE_ADMIN_API_URL || 'http://localhost:8787';

// Screen-reader-only cue for links that open a new tab (L4 / WCAG G201).
const NewTabHint = () => <span className="sr-only"> (opens in a new tab)</span>;

export function App() {
  return (
    <ToastProvider>
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
          <AuthedRoutes />
        </ErrorBoundary>
      </SignedIn>
    </ToastProvider>
  );
}

// Fetch the store list + identity once, provide them to every route, and define the route tree.
// Super admins default to /admin; everyone else to their first store (/stores/:id).
function AuthedRoutes() {
  const api = useApi();
  const toast = useToast();
  const [stores, setStores] = useState<Store[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
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
  useEffect(() => {
    let cancelled = false;
    const loadMe = (attempt = 0) =>
      api
        .me()
        .then((m) => {
          if (!cancelled) {
            setMe(m);
            setMeLoaded(true);
          }
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < 1) loadMe(attempt + 1);
          else setMeLoaded(true); // degrade to the non-admin view after a retry
        });
    loadMe();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const dialog = creating && (
    <CreateStoreDialog
      api={api}
      onClose={() => setCreating(false)}
      onCreated={() => {
        setCreating(false);
        toast('Store created');
        load();
      }}
    />
  );

  if (error) {
    return (
      <main className="container">
        <div className="note note-error" role="alert">
          {error}
        </div>
      </main>
    );
  }
  // Wait for BOTH stores and identity before routing, so the role-based landing lands correctly.
  if (!stores || !meLoaded) {
    return (
      <div className="center-pad">
        <Spinner />
      </div>
    );
  }
  if (stores.length === 0) {
    return (
      <main className="container">
        <EmptyState emoji="🏪" title="No stores yet">
          <p className="muted" style={{ maxWidth: 320 }}>
            Create your first store — it goes live instantly at its own subdomain.
          </p>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon.plus /> Create a store
          </button>
        </EmptyState>
        <div className="onboard-ask">
          <p className="muted" style={{ textAlign: 'center', fontSize: 13 }}>
            …or just tell Ratio to set it up for you.
          </p>
          <AskRatio api={api} storeId={null} onChanged={load} />
        </div>
        {dialog}
      </main>
    );
  }

  return (
    <StoreDataProvider
      value={{ api, stores, me, reload: load, openCreate: () => setCreating(true) }}
    >
      <Routes>
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <PlatformLayout />
            </RequireAdmin>
          }
        >
          <Route index element={<SuperAdminPage />} />
        </Route>
        {/* Full-screen code editor — its own route, OUTSIDE MerchantLayout (no nav / search / Ask
            Ratio), so the IDE fills the viewport. Launched from the Theme page. */}
        <Route path="/stores/:storeId/editor" element={<FullScreenEditorPage />} />
        <Route path="/stores/:storeId" element={<MerchantLayout />}>
          <Route index element={<HomePage />} />
          <Route path="theme" element={<ThemesListPage />} />
          <Route path="theme/settings" element={<ThemePage />} />
          <Route path="pages" element={<PagesPage />} />
          <Route path="domains" element={<DomainsPage />} />
          <Route path="commerce" element={<CommercePage />} />
          <Route path="access" element={<AccessPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="danger" element={<DangerPage />} />
          <Route path="*" element={<ComingSoonPage />} />
        </Route>
        <Route path="*" element={<RoleRedirect />} />
      </Routes>
      {dialog}
    </StoreDataProvider>
  );
}

// Bare "/" (and any unknown path) → the right home for the role.
function RoleRedirect() {
  const { stores, me } = useStoreData();
  if (me?.isPlatformAdmin) return <Navigate to="/admin" replace />;
  return <Navigate to={`/stores/${storeSlug(stores[0])}`} replace />;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { me } = useStoreData();
  if (!me?.isPlatformAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/* Route elements: thin wrappers that pull api + the resolved store from context (or the store list
   for the platform view) and render the real panel. */
function SuperAdminPage() {
  const { stores, me, openCreate } = useStoreData();
  return <SuperAdmin stores={stores} isLocal={!!me?.isLocal} onCreate={openCreate} />;
}
function HomePage() {
  const { store } = useMerchant();
  return <DashboardHome storeName={store.name} />;
}
// Themes landing — lists the store's themes (one working theme per store today). Each opens Customize
// (brand settings + versions) or the full-screen code editor.
function ThemesListPage() {
  const { store } = useMerchant();
  const navigate = useNavigate();
  const slug = storeSlug(store);
  return (
    <div className="fade-in" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div className="head-text">
          <h1>Themes</h1>
          <p className="muted">
            Your storefront's themes — customize the settings or edit the code.
          </p>
        </div>
      </div>
      <div
        className="card"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <strong>{store.name} theme</strong>
          <span className="muted" style={{ fontSize: 13 }}>
            Current live theme
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="btn btn-sm" onClick={() => navigate(`/stores/${slug}/theme/settings`)}>
            Customize
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => navigate(`/stores/${slug}/editor`)}
          >
            Edit code
          </button>
        </div>
      </div>
    </div>
  );
}
// Theme customize = brand settings + version history, as tabs (Versions is owner-only). Reached from
// the Themes list; "Edit code" launches the full-screen code editor (its own chrome-less route).
function ThemePage() {
  const { api, store } = useMerchant();
  const navigate = useNavigate();
  const owner = store.role === 'owner';
  const [tab, setTab] = useState<'settings' | 'versions'>('settings');
  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="head-text">
          <button
            className="btn btn-ghost btn-sm"
            style={{ marginBottom: 6 }}
            onClick={() => navigate(`/stores/${storeSlug(store)}/theme`)}
          >
            <Icon.back /> Themes
          </button>
          <h1>{store.name} theme</h1>
          <p className="muted">Your storefront's brand settings and published versions.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="btn btn-sm"
            onClick={() => navigate(`/stores/${storeSlug(store)}/editor`)}
          >
            Edit code
          </button>
          {/* Only owners have a second view (Versions), so the tab switcher is owner-only — a member
              would otherwise see a lone, pointless "Settings" tab. */}
          {owner && (
            <div className="seg">
              <button
                className={tab === 'settings' ? 'on' : ''}
                aria-pressed={tab === 'settings'}
                onClick={() => setTab('settings')}
              >
                Settings
              </button>
              <button
                className={tab === 'versions' ? 'on' : ''}
                aria-pressed={tab === 'versions'}
                onClick={() => setTab('versions')}
              >
                Versions
              </button>
            </div>
          )}
        </div>
      </div>
      {tab === 'versions' && owner ? (
        <ThemeVersionsPanel api={api} store={store} />
      ) : (
        <ThemeSettingsPanel api={api} store={store} />
      )}
    </div>
  );
}
// The full-screen code editor route: resolves the store from the URL (it's outside MerchantLayout, so
// there's no useMerchant context) and renders the IDE with a back button to the Theme page.
function FullScreenEditorPage() {
  const { api, stores, me } = useStoreData();
  const { storeId } = useParams();
  const navigate = useNavigate();
  const store = resolveStore(stores, storeId);
  if (!store) return <Navigate to="/" replace />;
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="center-pad">
            <Spinner />
          </div>
        }
      >
        <ThemeCodeEditor
          api={api}
          store={store}
          isLocal={!!me?.isLocal}
          onBack={() => navigate(`/stores/${storeSlug(store)}/theme`)}
        />
      </Suspense>
    </ErrorBoundary>
  );
}
function PagesPage() {
  const { api, store } = useMerchant();
  const { me } = useStoreData();
  const [editing, setEditing] = useState<{ path: string; isNew: boolean; title?: string } | null>(
    null
  );
  if (editing)
    return (
      <PageEditor
        api={api}
        store={store}
        path={editing.path}
        isNew={editing.isNew}
        isLocal={!!me?.isLocal}
        initialTitle={editing.title}
        onBack={() => setEditing(null)}
      />
    );
  return (
    <PagesList
      api={api}
      store={store}
      onOpen={(path, isNew, title) => setEditing({ path, isNew, title })}
    />
  );
}
function DomainsPage() {
  const { api, store } = useMerchant();
  return <DomainsPanel api={api} store={store} />;
}
function CommercePage() {
  const { api, store } = useMerchant();
  return <CommercePanel api={api} store={store} />;
}
function AccessPage() {
  const { api, store } = useMerchant();
  return <AgentAccessPanel api={api} store={store} />;
}
function AuditPage() {
  const { api, store } = useMerchant();
  return <AuditPanel api={api} store={store} />;
}
function DangerPage() {
  const { api, store } = useMerchant();
  const { reload } = useStoreData();
  const navigate = useNavigate();
  return (
    <DangerPanel
      api={api}
      store={store}
      onDeleted={() => {
        reload();
        navigate('/');
      }}
    />
  );
}
function ComingSoonPage() {
  const { store } = useMerchant();
  const location = useLocation();
  const navigate = useNavigate();
  const seg = location.pathname.split('/').pop() || '';
  return <ComingSoon route={seg} onHome={() => navigate(`/stores/${store.id}`)} />;
}

function useApi(): Api {
  const { getToken } = useAuth();
  return useMemo(() => createApi(API_URL, () => getToken()), [getToken]);
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
  const [f, setF] = useState({ name: '', host: '', color: '#2563eb', merchantId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createStore({ ...f, merchantId: f.merchantId.trim() || undefined });
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
          <Field label="Name">
            <input
              className="input"
              placeholder="Acme"
              value={f.name}
              onChange={set('name')}
              required
            />
          </Field>
          <Field label="Domain">
            <input
              className="input"
              placeholder="acme.ratiodev.in"
              value={f.host}
              onChange={set('host')}
              required
            />
          </Field>
          <Field
            label="Merchant ID (gokwik)"
            info="Connects live products from the commerce backend. Optional — leave blank for a store with no catalogue yet."
          >
            <input
              className="input mono"
              placeholder="196jdfqy1aot"
              value={f.merchantId}
              onChange={set('merchantId')}
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
          {err && (
            <div className="note note-error" role="alert">
              {err}
            </div>
          )}
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

// Connect the store's commerce backend (its GoKwik merchant id). Without it, the page builder can't
// list collections/products ("connect the store's commerce backend"). Mirrors the theme panel.
function ThemeVersionsPanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [published, setPublished] = useState<number | null>(null);
  const [versions, setVersions] = useState<ThemeVersion[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .themeVersions(store.id)
      .then((d) => {
        setPublished(d.published);
        setVersions(d.versions);
      })
      .catch((e: Error) => setErr(e.message));
  }, [api, store.id]);
  useEffect(load, [load]);

  async function publish() {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.publishTheme(store.id, note.trim() || undefined, published);
      toast(`Published theme v${res.version}`, 'ok');
      setNote('');
      load();
    } catch (e) {
      setErr((e as Error).message);
      toast('Could not publish the theme', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function rollback(v: number) {
    setBusy(true);
    setErr(null);
    try {
      await api.rollbackTheme(store.id, v);
      toast(`Rolled back to v${v}`, 'ok');
      load();
    } catch (e) {
      setErr((e as Error).message);
      toast('Could not roll back', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>Theme versions</h2>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>
        Publishing snapshots the whole store (all pages + theme tokens) as an immutable version and
        takes it live. Roll back to any earlier version at any time — it's non-destructive.
      </p>
      <Field label="Note (optional)">
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Diwali homepage"
        />
      </Field>
      {err && (
        <div className="note note-error" role="alert">
          {err}
        </div>
      )}
      <button
        type="button"
        className="btn btn-primary"
        onClick={publish}
        disabled={busy}
        style={{ marginTop: 10 }}
      >
        {busy ? <Spinner /> : <Icon.check />} Publish theme
      </button>

      <div style={{ marginTop: 16 }}>
        {versions === null ? (
          <Spinner />
        ) : versions.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            Nothing published yet.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {versions.map((v) => (
              <li
                key={v.version}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 0',
                  borderTop: '1px solid var(--border, #eee)',
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <strong>v{v.version}</strong>
                  {v.version === published && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        color: 'var(--ok, #137333)',
                        fontWeight: 600,
                      }}
                    >
                      ● live
                    </span>
                  )}
                  {v.note && (
                    <span className="muted" style={{ marginLeft: 8 }}>
                      {v.note}
                    </span>
                  )}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </span>
                {v.version !== published && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => rollback(v.version)}
                    disabled={busy}
                  >
                    Roll back
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CommercePanel({ api, store }: { api: Api; store: Store }) {
  const toast = useToast();
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getCommerce(store.id)
      .then(setMerchantId)
      .catch((e: Error) => {
        setMerchantId('');
        setErr(e.message);
      });
  }, [api, store.id]);

  async function save() {
    if (merchantId === null) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await api.saveCommerce(store.id, merchantId.trim());
      setMerchantId(res.merchantId);
      toast(res.merchantId ? 'Commerce backend connected' : 'Commerce backend disconnected', 'ok');
    } catch (e) {
      setErr((e as Error).message);
      toast('Could not save the commerce backend', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>Commerce</h2>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>
        Connect the store's commerce backend by its GoKwik merchant id — this powers products,
        collections, cart, and checkout. Leave blank to disconnect.
      </p>
      {merchantId === null && !err ? (
        <Spinner />
      ) : (
        <>
          <Field label="Merchant ID">
            <input
              className="input mono"
              value={merchantId ?? ''}
              onChange={(e) => setMerchantId(e.target.value)}
              placeholder="e.g. 196jdfqy1aot"
            />
          </Field>
          {err && (
            <div className="note note-error" role="alert">
              {err}
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={saving}
            style={{ marginTop: 10 }}
          >
            {saving ? <Spinner /> : <Icon.check />} Save
          </button>
        </>
      )}
    </div>
  );
}

// Permanently remove a store. Destructive + irreversible, so it's owner-only and gated behind a
// type-the-name confirmation. The API's DELETE /stores/:id does the transactional hard-delete
// (pages + domains + memberships) and cache/edge cleanup; this just triggers it and returns home.
function DangerPanel({ api, store, onDeleted }: { api: Api; store: Store; onDeleted: () => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      await api.deleteStore(store.id);
      toast('Store removed');
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      toast('Could not remove the store', 'error');
      setBusy(false);
    }
  }

  return (
    <div className="card pane">
      <div className="pane-head">
        <h2>Danger zone</h2>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 14px' }}>
        Removing this store permanently deletes it — its pages, domains, and access. This cannot be
        undone.
      </p>
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => {
          setTyped('');
          setErr(null);
          setConfirming(true);
        }}
      >
        <Icon.trash size={14} /> Remove store
      </button>
      {confirming && (
        <Dialog
          title="Remove this store?"
          onClose={() => (busy ? undefined : setConfirming(false))}
        >
          <div className="body">
            <p>
              This permanently deletes <span className="mono">{store.name}</span> and everything in
              it — pages, domains, and access. This cannot be undone.
            </p>
            <p style={{ marginTop: 12 }}>
              Type <span className="mono">{store.name}</span> to confirm:
            </p>
            <input
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Type the store name to confirm"
              autoFocus
            />
            {err && (
              <div className="note note-error" role="alert">
                {err}
              </div>
            )}
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={remove}
              disabled={busy || typed !== store.name}
            >
              <Icon.trash size={14} /> {busy ? 'Removing…' : 'Remove permanently'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
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
        carefully. Generating a new key does <strong>not</strong> disable an old one; each key stays
        valid until it expires.
      </p>
      {err && (
        <div className="note note-error" role="alert">
          {err}
        </div>
      )}
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
      {err && (
        <div className="note note-error" role="alert">
          {err}
        </div>
      )}
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
    if (d.status === 'active' && d.sslStatus === 'active')
      return <span className="badge dot-ok">live</span>;
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
      {err && (
        <div className="note note-error" role="alert">
          {err}
        </div>
      )}
      {!domains && !err && (
        <div className="center-pad">
          <Spinner />
        </div>
      )}
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
                <button
                  className="icon-btn"
                  aria-label="Remove domain"
                  onClick={() => setRemoving(d.host)}
                >
                  <Icon.trash size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {connecting && (
        <ConnectDomainDialog
          api={api}
          store={store}
          onClose={() => setConnecting(false)}
          onDone={() => {
            setConnecting(false);
            load();
          }}
        />
      )}
      {viewing && (
        <DomainRecordsDialog
          api={api}
          store={store}
          host={viewing}
          onClose={() => {
            setViewing(null);
            load();
          }}
        />
      )}
      {removing && (
        <Dialog title="Remove this domain?" onClose={() => setRemoving(null)}>
          <div className="body">
            <p>
              Remove <span className="mono">{removing}</span> from this store? The store will stop
              serving on it immediately until you reconnect it.
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
        <em>Host/Name</em> is the part before your domain (the middle column) — use{' '}
        <strong>Copy</strong> so values paste in exactly.
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
        {err && (
          <div className="note note-error" role="alert">
            {err}
          </div>
        )}
        {!result && !err && (
          <div className="center-pad">
            <Spinner />
          </div>
        )}
        {result && (
          <>
            {result.status && (
              <div
                className={
                  result.status === 'active' ? 'note note-ok dns-status' : 'note dns-status'
                }
              >
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
              <input
                className="input mono"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="shop.yourbrand.com"
                required
              />
            </Field>
            <p className="muted" style={{ fontSize: 12.5 }}>
              We'll issue an SSL certificate and give you the exact DNS records to add at your
              registrar.
            </p>
            {err && (
              <div className="note note-error" role="alert">
                {err}
              </div>
            )}
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
