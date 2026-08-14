import { lazy, Suspense } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ErrorBoundary, Spinner } from '../common/ui';
import { resolveStore, storeSlug, useStoreData } from '../common/store-context';

// Lazy: the code editor pulls in CodeMirror (~200KB) — keep it out of the main bundle so it only
// loads when a merchant actually opens the theme-code route.
const ThemeCodeEditor = lazy(() =>
  import('../features/theme/theme-editor').then((m) => ({ default: m.ThemeCodeEditor }))
);

// The full-screen code editor route: resolves the store from the URL (it's outside MerchantLayout, so
// there's no useMerchant context) and renders the IDE with a back button to the Theme page.
export function FullScreenEditorPage() {
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
