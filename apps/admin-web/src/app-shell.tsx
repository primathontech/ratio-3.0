import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { UserButton } from '@clerk/clerk-react';
import { useTheme } from './theme';
import { Icon } from './ui';
import { NAV, type NavItem } from './dashboard-data';
import { AskRatio } from './ask-sophie';
import { CommandPalette, type Command } from './command-palette';
import { useStoreData } from './store-context';

// The merchant shell for a single store (/stores/:storeId/*): sidebar + top bar + Ask rail, with
// the route content in <Outlet>. The current store lives in the URL.
export function MerchantLayout() {
  const { storeId } = useParams();
  const { api, stores, me, reload, openCreate } = useStoreData();
  const navigate = useNavigate();
  const location = useLocation();
  const { resolved, cycle } = useTheme();

  const [askOpen, setAskOpen] = useState(
    typeof window !== 'undefined' ? window.innerWidth >= 1200 : true
  );
  const [narrow, setNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 1200 : false
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1200);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Focus the main region on navigation so keyboard/SR users aren't stranded (WCAG 2.4.3).
  useEffect(() => {
    mainRef.current?.focus();
  }, [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === 'Escape' && narrow) {
        setAskOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow]);

  const store = stores.find((s) => s.id === storeId);
  if (!store) return <Navigate to="/" replace />;
  const owner = store.role === 'owner';

  const pathFor = (route: string) =>
    route === 'admin'
      ? '/admin'
      : route === 'home'
        ? `/stores/${store.id}`
        : `/stores/${store.id}/${route}`;

  const groups = NAV.map((g) => ({
    title: g.title,
    items: g.items.filter(
      (it) => (!it.ownerOnly || owner) && (!it.adminOnly || me?.isPlatformAdmin)
    ),
  })).filter((g) => g.items.length > 0);

  const commands: Command[] = groups.flatMap((g) =>
    g.items.map((it) => ({
      label: `Go to ${it.label}`,
      group: g.title,
      run: () => navigate(pathFor(it.route)),
    }))
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="sidebar-brand"
          aria-label={
            stores.length > 1
              ? `Current store: ${store.name}. Activate to switch store.`
              : store.name
          }
          onClick={() =>
            navigate(
              `/stores/${stores[(stores.findIndex((s) => s.id === store.id) + 1) % stores.length].id}`
            )
          }
        >
          <span className="logo">R</span>
          <span className="brand-meta">
            <span className="brand-name">{store.name}</span>
            <span className="brand-sub">{owner ? 'Owner' : 'Member'}</span>
          </span>
          {stores.length > 1 && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>⌄</span>}
        </button>

        <div className="sidebar-nav">
          {groups.map((g) => (
            <div className="nav-group" key={g.title}>
              <div className="nav-group-title">{g.title}</div>
              {g.items.map((it: NavItem) => (
                <NavLink
                  key={it.route}
                  to={pathFor(it.route)}
                  end={it.route === 'home'}
                  className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
                >
                  <span className="bar" />
                  <span style={{ flex: 1 }}>{it.label}</span>
                  {it.hint && <span className="hint">{it.hint}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </div>

        <div className="nav-card">
          <div style={{ fontSize: 13, fontWeight: 600 }}>Add a store</div>
          <p style={{ margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--muted)' }}>
            Spin up another storefront — it goes live instantly.
          </p>
          <button className="btn btn-primary btn-sm" style={{ marginTop: 2 }} onClick={openCreate}>
            <Icon.plus /> New store
          </button>
        </div>
      </aside>

      <div className="main-area">
        <header className="appbar">
          <button
            className="cmdk-trigger"
            onClick={() => setPaletteOpen(true)}
            aria-haspopup="dialog"
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: '1.5px solid var(--text-3)',
                flex: 'none',
              }}
            />
            <span className="label">Search or ask Ratio to do something…</span>
            <span className="kbd">⌘K</span>
          </button>
          <div className="right">
            <button className="btn btn-ghost" onClick={cycle}>
              {resolved === 'dark' ? 'Light' : 'Dark'}
            </button>
            <button
              className={askOpen ? 'btn btn-primary' : 'btn btn-ghost'}
              onClick={() => setAskOpen((o) => !o)}
            >
              Ask Ratio
            </button>
            <UserButton afterSignOutUrl="/" />
          </div>
        </header>

        <div className={askOpen ? 'shell-body with-ask' : 'shell-body'}>
          <main
            className="container"
            style={{ overflow: 'auto', outline: 'none' }}
            ref={mainRef}
            tabIndex={-1}
          >
            <Outlet context={{ api, store }} />
          </main>
          {askOpen && (
            <>
              {narrow && (
                <div className="ask-backdrop" onClick={() => setAskOpen(false)} aria-hidden />
              )}
              <AskRatio
                api={api}
                storeId={store.id}
                overlay={narrow}
                onChanged={reload}
                onClose={() => setAskOpen(false)}
              />
            </>
          )}
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}

// The platform (super-admin) view (/admin): no store sidebar, its own top bar, Merchants in Outlet.
export function PlatformLayout() {
  const { stores } = useStoreData();
  const navigate = useNavigate();
  const { resolved, cycle } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const first = stores[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const commands: Command[] = first
    ? [{ label: 'Merchant view', group: 'Navigate', run: () => navigate(`/stores/${first.id}`) }]
    : [];

  return (
    <div className="app-shell no-sidebar">
      <div className="main-area">
        <header className="appbar">
          <span className="brand">
            <span className="logo">R</span>
            Ratio Platform
            <span className="badge badge-accent">Super admin</span>
          </span>
          <button
            className="cmdk-trigger"
            style={{ flex: 'none', width: 220, marginLeft: 'auto' }}
            onClick={() => setPaletteOpen(true)}
            aria-haspopup="dialog"
          >
            <span className="label">Search platform…</span>
            <span className="kbd">⌘K</span>
          </button>
          <div className="right">
            <button className="btn btn-ghost" onClick={cycle}>
              {resolved === 'dark' ? 'Light' : 'Dark'}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => first && navigate(`/stores/${first.id}`)}
            >
              Merchant view
            </button>
            <UserButton afterSignOutUrl="/" />
          </div>
        </header>
        <div className="shell-body">
          <main className="container" style={{ overflow: 'auto' }}>
            <Outlet />
          </main>
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}

// Placeholder for nav destinations that aren't built yet (Orders, Products, Analytics, …).
export function ComingSoon({ route, onHome }: { route: string; onHome: () => void }) {
  const title = route.charAt(0).toUpperCase() + route.slice(1);
  return (
    <div className="empty fade-in" style={{ maxWidth: 520, margin: '12vh auto 0' }}>
      <span className="emoji">🚧</span>
      <h2>{title}</h2>
      <p className="muted" style={{ maxWidth: 360 }}>
        Not part of this build yet. Ask Ratio about {route.toLowerCase()}, or jump back to the
        screens that are ready.
      </p>
      <button className="btn btn-primary" onClick={onHome}>
        Back to Home
      </button>
    </div>
  );
}
