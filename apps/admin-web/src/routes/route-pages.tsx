import { type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AgentAccessPanel } from '../features/access/agent-access-panel';
import { SuperAdmin } from '../features/admin/superadmin';
import { SuperAdminUsers } from '../features/admin/superadmin-users';
import { AuditPanel } from '../features/audit/audit-panel';
import { CommercePanel } from '../features/commerce/commerce-panel';
import { DashboardHome } from '../features/dashboard/dashboard';
import { DomainsPanel } from '../features/domains/domains-panel';
import { ComingSoon } from '../features/shell/app-shell';
import { DangerPanel } from '../features/stores/danger-panel';
import { ThemesList } from '../features/theme/themes-list';
import { storeSlug, useMerchant, useStoreData } from '../common/store-context';
import { AllStores } from '../features/all-stores/all-stores';

// Bare "/" (and any unknown path) → the right home for the role.
export function RoleRedirect() {
  const { stores, me } = useStoreData();
  if (me?.isPlatformAdmin) return <Navigate to="/admin" replace />;
  return <Navigate to={`/stores/${storeSlug(stores[0])}`} replace />;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { me } = useStoreData();
  if (!me?.isPlatformAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/* Route elements: thin wrappers that pull api + the resolved store from context (or the store list
   for the platform view) and render the real panel. */
export function SuperAdminPage() {
  const { stores, me, openCreate } = useStoreData();
  return <SuperAdmin stores={stores} isLocal={!!me?.isLocal} onCreate={openCreate} />;
}

export function SuperAdminUsersPage() {
  const { api, openCreate } = useStoreData();
  return <SuperAdminUsers api={api} onCreate={openCreate} />;
}

export function Stores() {
  const { stores, me, openCreate } = useStoreData();
  return <AllStores stores={stores} isLocal={!!me?.isLocal} onCreate={openCreate} />;
}

export function HomePage() {
  const { store } = useMerchant();
  return <DashboardHome storeName={store.name} />;
}
// Themes landing — the store's live theme as a card with a preview thumbnail (see themes-list.tsx).
export function ThemesListPage() {
  const { api, store } = useMerchant();
  return <ThemesList api={api} store={store} />;
}
export function DomainsPage() {
  const { api, store } = useMerchant();
  return <DomainsPanel api={api} store={store} />;
}
export function CommercePage() {
  const { api, store } = useMerchant();
  return <CommercePanel api={api} store={store} />;
}
export function AccessPage() {
  const { api, store } = useMerchant();
  return <AgentAccessPanel api={api} store={store} />;
}
export function AuditPage() {
  const { api, store } = useMerchant();
  return <AuditPanel api={api} store={store} />;
}
export function DangerPage() {
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
export function ComingSoonPage() {
  const { store } = useMerchant();
  const location = useLocation();
  const navigate = useNavigate();
  const seg = location.pathname.split('/').pop() || '';
  return <ComingSoon route={seg} onHome={() => navigate(`/stores/${store.id}`)} />;
}
