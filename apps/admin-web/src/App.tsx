import { useCallback, useEffect, useMemo, useState } from 'react';
import { SignedIn, SignedOut, SignIn, useAuth } from '@clerk/clerk-react';
import { createApi, type Api, type Store } from './common/api';
import { EmptyState, ErrorBoundary, Icon, Spinner, ToastProvider } from './common/ui';
import { MerchantLayout, PlatformLayout } from './features/shell/app-shell';
import { AskRatio } from './features/assistant/ask-sophie';
import { OnboardingWizard } from './features/onboarding/onboarding-wizard';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
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
  Stores,
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
  const navigate = useNavigate();
  const [stores, setStores] = useState<Store[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openCreate = useCallback(() => navigate('/stores/new'), [navigate]);

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
  // A brand-new merchant with no stores yet — the empty state is the onboarding entry point.
  const emptyState = (
    <main className="onboard-home">
      <EmptyState emoji="🏪" title="No stores yet">
        <p className="muted" style={{ maxWidth: 320 }}>
          Create your first store — it goes live instantly at its own subdomain.
        </p>
        <button className="btn btn-primary" onClick={openCreate}>
          <Icon.plus /> Create a store
        </button>
      </EmptyState>
      <div className="onboard-or" aria-hidden>
        <b>OR</b>
      </div>
      <div className="onboard-ask">
        <AskRatio api={api} storeId={null} onChanged={load} />
      </div>
    </main>
  );

  return (
    <StoreDataProvider value={{ api, stores, me, reload: load, openCreate }}>
      <Routes>
        {/* Guided onboarding — chrome-less (its own header/stepper), OUTSIDE MerchantLayout, and
            BEFORE /stores/:storeId so "new" isn't captured as a store id. Always mounted, so a
            merchant with zero stores can still reach it (that's who it's for). */}
        <Route path="/stores/new" element={<OnboardingWizard />} />
        {/* Platform admin console is store-independent, so it's always mounted (RequireAdmin gates it)
            — a platform admin with zero stores must still reach it, not be trapped on the empty state. */}
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
        {stores.length === 0 ? (
          // No stores: merchants get the create-store empty state; platform admins go to /admin.
          <Route
            path="*"
            element={me?.isPlatformAdmin ? <Navigate to="/admin" replace /> : emptyState}
          />
        ) : (
          <>
            {/* Full-screen code editor — its own route, OUTSIDE MerchantLayout (no nav / search /
                Ask Ratio), so the IDE fills the viewport. Launched from the Theme page. */}
            <Route
              path="/stores/:storeId/themes/:themeId/editor"
              element={<FullScreenEditorPage />}
            />
            <Route path="/stores/:storeId" element={<MerchantLayout />}>
              <Route index element={<Stores />} />
              <Route path="dashboard" element={<HomePage />} />
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
          </>
        )}
      </Routes>
    </StoreDataProvider>
  );
}

function useApi(): Api {
  const { getToken } = useAuth();
  return useMemo(() => createApi(API_URL, () => getToken()), [getToken]);
}
