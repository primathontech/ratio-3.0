import { useCallback, useEffect, useMemo, useState } from 'react';
import { SignedIn, SignedOut, SignIn, useAuth } from '@clerk/clerk-react';
import { createApi, type Api, type Store } from './common/api';
import { EmptyState, ErrorBoundary, Icon, Spinner, ToastProvider, useToast } from './common/ui';
import { CreateStoreDialog } from './features/stores/create-store-dialog';
import { MerchantLayout, PlatformLayout } from './features/shell/app-shell';
import { AskRatio } from './features/assistant/ask-sophie';
import { Route, Routes } from 'react-router-dom';
import { StoreDataProvider, type Me } from './common/store-context';
import { ThemePage } from './routes/theme-page';
import { FullScreenEditorPage } from './routes/full-screen-editor-page';
import { PagesPage } from './routes/pages-page';
import {
  AccessPage,
  AuditPage,
  CommercePage,
  ComingSoonPage,
  DangerPage,
  DomainsPage,
  HomePage,
  RequireAdmin,
  RoleRedirect,
  SuperAdminPage,
  ThemesListPage,
} from './routes/route-pages';

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

function useApi(): Api {
  const { getToken } = useAuth();
  return useMemo(() => createApi(API_URL, () => getToken()), [getToken]);
}
