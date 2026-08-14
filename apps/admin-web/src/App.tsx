import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { SignedIn, SignedOut, SignIn, useAuth } from '@clerk/clerk-react';
import { createApi, type Api, type Store } from './common/api';
import { EmptyState, ErrorBoundary, Icon, Spinner, ToastProvider, useToast } from './common/ui';
import { PageEditor } from './features/pages/pagebuilder';
import { PagesList } from './features/pages/pages-list';
// Lazy: the code editor pulls in CodeMirror (~200KB) — keep it out of the main bundle so it only
// loads when a merchant actually opens the theme-code route.
const ThemeCodeEditor = lazy(() =>
  import('./features/theme/theme-editor').then((m) => ({ default: m.ThemeCodeEditor }))
);
import { ThemeSettingsPanel } from './features/theme/theme-settings';
import { ThemeVersionsPanel } from './features/theme/theme-versions-panel';
import { ThemesList } from './features/theme/themes-list';
import { CreateStoreDialog } from './features/stores/create-store-dialog';
import { DangerPanel } from './features/stores/danger-panel';
import { CommercePanel } from './features/commerce/commerce-panel';
import { AgentAccessPanel } from './features/access/agent-access-panel';
import { AuditPanel } from './features/audit/audit-panel';
import { DomainsPanel } from './features/domains/domains-panel';
import { PageHeader } from './common/page-header';
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
        <Route path="/stores/:storeId/themes/:themeId/editor" element={<FullScreenEditorPage />} />
        <Route path="/stores/:storeId" element={<MerchantLayout />}>
          <Route index element={<HomePage />} />
          <Route path="themes" element={<ThemesListPage />} />
          <Route path="themes/:themeId" element={<ThemePage />} />
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
// Themes landing — the store's live theme as a card with a preview thumbnail (see themes-list.tsx).
function ThemesListPage() {
  const { api, store } = useMerchant();
  return <ThemesList api={api} store={store} />;
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
      <PageHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {store.name} theme <span className="theme-pill">Live</span>
          </span>
        }
        description={
          store.host ? (
            <>
              Brand, typography and layout ·{' '}
              <a href={`https://${store.host}`} target="_blank" rel="noreferrer">
                {store.host} ↗
              </a>
            </>
          ) : (
            'Brand, typography and layout for your storefront.'
          )
        }
        onBack={() => navigate(`/stores/${storeSlug(store)}/themes`)}
        backLabel="Themes"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {store.host && (
            <a
              className="btn btn-ghost btn-sm"
              href={`https://${store.host}`}
              target="_blank"
              rel="noreferrer"
            >
              View store ↗
            </a>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              navigate(`/stores/${storeSlug(store)}/themes/${store.id}/editor`, {
                state: { fromApp: true },
              })
            }
          >
            Edit code
          </button>
        </div>
      </PageHeader>
      {/* Only owners have a second view (Versions), so the tab strip is owner-only — a member would
          otherwise see a lone, pointless "Settings" tab. */}
      {owner && (
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
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
  const { storeId, themeId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const store = resolveStore(stores, storeId);
  if (!store) return <Navigate to="/" replace />;
  // Prefer real "go back" (list vs settings, wherever the user came from), but only when we opened
  // the editor from within the app — a deep-linked editor URL falls back to the theme's page.
  const cameFromApp = (location.state as { fromApp?: boolean } | null)?.fromApp;
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
          onBack={() =>
            cameFromApp
              ? navigate(-1)
              : navigate(`/stores/${storeSlug(store)}/themes/${themeId ?? store.id}`)
          }
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
