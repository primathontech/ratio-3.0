import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { UserButton } from '@clerk/clerk-react';
import { useTheme } from './theme';
import { Icon } from './ui';
import { NAV, type NavItem } from './dashboard-data';
import { AskRatio } from './ask-sophie';
import { CommandPalette, type Command } from './command-palette';
import { resolveStore, storeSlug, storefrontUrl, useStoreData } from './store-context';

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
  const [storePickerOpen, setStorePickerOpen] = useState(false);
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

  const store = resolveStore(stores, storeId);
  if (!store) return <Navigate to="/" replace />;
  const owner = store.role === 'owner';
  const slug = storeSlug(store);
  const liveUrl = storefrontUrl(store, !!me?.isLocal);

  const pathFor = (route: string) =>
    route === 'admin'
      ? '/admin'
      : route === 'home'
        ? `/stores/${slug}`
        : `/stores/${slug}/${route}`;

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

  // Switch store via a searchable picker — cycling one-by-one doesn't scale to many stores.
  const storeCommands: Command[] = useMemo(
    () =>
      stores.map((s) => ({
        label: s.name,
        group: s.host ?? '',
        run: () => navigate(`/stores/${storeSlug(s)}`),
      })),
    [stores, navigate]
  );
  const multiStore = stores.length > 1;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="sidebar-brand"
          aria-haspopup={multiStore ? 'dialog' : undefined}
          aria-label={multiStore ? `Current store: ${store.name}. Switch store.` : store.name}
          onClick={() => multiStore && setStorePickerOpen(true)}
        >
          <img className="brand-logo" src="/logo.svg" alt="Ratio" />
          <span className="brand-meta">
            <span className="brand-name">{store.name}</span>
            <span className="brand-sub">{owner ? 'Owner' : 'Member'}</span>
          </span>
          {multiStore && <Icon.selector />}
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
          <div className="right">
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
            <button
              className="icon-btn"
              onClick={cycle}
              aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={resolved === 'dark' ? 'Light' : 'Dark'}
            >
              {resolved === 'dark' ? <Icon.sun /> : <Icon.moon />}
            </button>
            {liveUrl && (
              <a
                className="btn btn-ghost"
                href={liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open this store's storefront in a new tab"
              >
                View storefront <Icon.external size={14} />
              </a>
            )}
            <button
              className={askOpen ? 'btn btn-primary' : 'btn btn-ghost'}
              onClick={() => setAskOpen((o) => !o)}
            >
              <Icon.sparkles size={15} /> Ask Ratio
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
      <CommandPalette
        open={storePickerOpen}
        onClose={() => setStorePickerOpen(false)}
        commands={storeCommands}
        placeholder="Switch store…"
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
    ? [
        {
          label: 'Stores',
          group: 'Navigate',
          run: () => navigate(`/stores/${storeSlug(first)}`),
        },
      ]
    : [];

  return (
    <div className="app-shell no-sidebar">
      <div className="main-area">
        <header className="appbar">
          <span className="brand">
            <img className="brand-logo" src="/logo.svg" alt="Ratio" />
            Ratio Platform
            <span className="badge badge-accent">Super admin</span>
          </span>
          <div className="right">
            <button
              className="cmdk-trigger"
              style={{ flex: 'none', width: 220, marginLeft: 'auto' }}
              onClick={() => setPaletteOpen(true)}
              aria-haspopup="dialog"
            >
              <span className="label">Search platform…</span>
              <span className="kbd">⌘K</span>
            </button>
            <button
              className="icon-btn"
              onClick={cycle}
              aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={resolved === 'dark' ? 'Light' : 'Dark'}
            >
              {resolved === 'dark' ? <Icon.sun /> : <Icon.moon />}
            </button>
            {first && (
              <a
                className="btn btn-ghost"
                href={`/stores/${storeSlug(first)}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open the store dashboard in a new tab"
              >
                Stores <Icon.external />
              </a>
            )}
            <UserButton />
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
