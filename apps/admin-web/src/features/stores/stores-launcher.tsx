import { useNavigate } from 'react-router-dom';
import { UserButton } from '@clerk/clerk-react';
import { Icon } from '../../common/ui';
import { ThemeToggle } from '../../common/theme-toggle';
import { storeSlug, storefrontUrl, useStoreData } from '../../common/store-context';
import type { Store } from '../../common/api';

// Merchant store picker at /stores — a chrome-less launchpad (no current store, so no store sidebar).
// A multi-store merchant lands here to choose a store; each card opens that store's dashboard.
const initials = (name: string) =>
  (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('') || '?'
  ).toUpperCase();

const roleLabel = (role: string) =>
  role === 'admin' ? 'Admin' : role === 'owner' ? 'Owner' : 'Member';

export function StoresLauncher() {
  const { stores, me, openCreate } = useStoreData();
  const navigate = useNavigate();
  const isLocal = !!me?.isLocal;
  const open = (s: Store) => navigate(`/stores/${storeSlug(s)}`);

  return (
    <div className="app-shell no-sidebar">
      <div className="main-area">
        <header className="appbar">
          <span className="brand">
            <img className="brand-logo" src="/logo.svg" alt="Ratio" />
            Ratio
          </span>
          <div className="right" style={{ marginLeft: 'auto' }}>
            <ThemeToggle />
            <UserButton afterSignOutUrl="/" />
          </div>
        </header>
        <div className="shell-body">
          <main className="container" style={{ overflow: 'auto' }}>
            <div className="page-head">
              <div className="head-text">
                <h1>Your stores</h1>
                <p>Pick a store to manage, or create a new one.</p>
              </div>
              <button className="btn btn-primary" onClick={openCreate}>
                <Icon.plus /> New store
              </button>
            </div>

            <div className="store-grid">
              {stores.map((s) => {
                const sfUrl = storefrontUrl(s, isLocal);
                return (
                  <div
                    key={s.id}
                    className="store-card"
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${s.name}`}
                    onClick={() => open(s)}
                    onKeyDown={(e) => {
                      // Only when the card itself has focus — let the nested storefront link handle
                      // its own Enter/Space instead of navigating to the dashboard.
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        open(s);
                      }
                    }}
                  >
                    <div className="store-card-head">
                      <span className="avatar avatar-sq" aria-hidden>
                        {initials(s.name)}
                      </span>
                      <span className="badge">{roleLabel(s.role)}</span>
                    </div>
                    <div className="store-card-name">{s.name}</div>
                    <div className="store-card-host mono">{s.host ?? '—'}</div>
                    {sfUrl && (
                      <a
                        className="store-card-link"
                        href={sfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        View storefront <Icon.external size={12} />
                      </a>
                    )}
                  </div>
                );
              })}

              <button className="store-card store-card-new" onClick={openCreate}>
                <Icon.plus />
                <span>New store</span>
              </button>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
