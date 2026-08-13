import { useEffect, useMemo, useRef, useState } from 'react';
import { UserButton } from '@clerk/clerk-react';
import type { Api, Store } from './api';
import { useTheme } from './theme';
import { Icon } from './ui';
import { NAV, type NavItem } from './dashboard-data';
import { AskRatio } from './ask-sophie';
import { CommandPalette, type Command } from './command-palette';

export interface ShellNav {
  go: (route: string) => void;
  enterStore: (store: Store) => void;
}

// The signed-in merchant shell: left sidebar (store switcher + nav) + top bar + routed main +
// the Ask Ratio rail. Layout/routing live here; the parent supplies the per-route content via
// `renderRoute` so the real store panels stay where they're defined (no circular imports).
export function AppShell({
  api,
  stores,
  isPlatformAdmin,
  onCreate,
  onChanged,
  renderRoute,
}: {
  api: Api;
  stores: Store[];
  isPlatformAdmin: boolean;
  onCreate: () => void;
  onChanged: () => void;
  renderRoute: (route: string, store: Store, nav: ShellNav) => React.ReactNode;
}) {
  const { resolved, cycle } = useTheme();
  // Super admins land on the platform "Merchants" view; everyone else on their store dashboard.
  const [route, setRoute] = useState(isPlatformAdmin ? 'admin' : 'home');
  // Track the selected store by id, not index: a reload (create/delete/assistant action) can reorder
  // or shrink `stores`, and an index would silently point at a different store.
  const [storeId, setStoreId] = useState<string>(stores[0]?.id);
  // 1200px is the single breakpoint: at/above it the Ask rail is a column, below it an overlay
  // drawer. Keep the initial-open check and the overlay logic on the same threshold as the CSS.
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

  const current = stores.find((s) => s.id === storeId) ?? stores[0];
  const owner = current?.role === 'owner';

  // Move focus to the main region on route / store change so keyboard + SR users aren't stranded on
  // a now-hidden control (WCAG 2.4.3).
  useEffect(() => {
    mainRef.current?.focus();
  }, [route, current?.id]);

  const groups = useMemo(
    () =>
      NAV.map((g) => ({
        title: g.title,
        items: g.items.filter(
          (it) => (!it.ownerOnly || owner) && (!it.adminOnly || isPlatformAdmin)
        ),
      })).filter((g) => g.items.length > 0),
    [owner, isPlatformAdmin]
  );

  const nav: ShellNav = {
    go: (r) => setRoute(r),
    enterStore: (s) => {
      setStoreId(s.id);
      setRoute('home');
    },
  };

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

  const commands: Command[] = groups.flatMap((g) =>
    g.items.map((it) => ({
      label: `Go to ${it.label}`,
      group: g.title,
      run: () => setRoute(it.route),
    }))
  );

  // The platform (super-admin) view is its own page: no store sidebar, its own top bar.
  const isPlatform = route === 'admin';
  const showAsk = askOpen && !isPlatform;

  return (
    <div className={isPlatform ? 'app-shell no-sidebar' : 'app-shell'}>
      {!isPlatform && (
        <aside className="sidebar">
          <button
            className="sidebar-brand"
            aria-label={
              stores.length > 1
                ? `Current store: ${current?.name}. Activate to switch store.`
                : current?.name
            }
            onClick={() => {
              const i = stores.findIndex((s) => s.id === current?.id);
              setStoreId(stores[(i + 1) % stores.length].id);
            }}
          >
            <span className="logo">R</span>
            <span className="brand-meta">
              <span className="brand-name">{current?.name ?? 'Ratio'}</span>
              <span className="brand-sub">{owner ? 'Owner' : 'Member'}</span>
            </span>
            {stores.length > 1 && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>⌄</span>}
          </button>

          <div className="sidebar-nav">
            {groups.map((g) => (
              <div className="nav-group" key={g.title}>
                <div className="nav-group-title">{g.title}</div>
                {g.items.map((it: NavItem) => (
                  <button
                    key={it.route}
                    className={it.route === route ? 'nav-item active' : 'nav-item'}
                    aria-current={it.route === route ? 'page' : undefined}
                    onClick={() => setRoute(it.route)}
                  >
                    <span className="bar" />
                    <span style={{ flex: 1 }}>{it.label}</span>
                    {it.hint && <span className="hint">{it.hint}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="nav-card">
            <div style={{ fontSize: 13, fontWeight: 600 }}>Add a store</div>
            <p style={{ margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--muted)' }}>
              Spin up another storefront — it goes live instantly.
            </p>
            <button className="btn btn-primary btn-sm" style={{ marginTop: 2 }} onClick={onCreate}>
              <Icon.plus /> New store
            </button>
          </div>
        </aside>
      )}

      <div className="main-area">
        <header className="appbar">
          {isPlatform && (
            <span className="brand">
              <span className="logo">R</span>
              Ratio Platform
              <span className="badge badge-accent">Super admin</span>
            </span>
          )}
          <button
            className="cmdk-trigger"
            style={isPlatform ? { flex: 'none', width: 220, marginLeft: 'auto' } : undefined}
            onClick={() => setPaletteOpen(true)}
            aria-haspopup="dialog"
          >
            {!isPlatform && (
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  border: '1.5px solid var(--text-3)',
                  flex: 'none',
                }}
              />
            )}
            <span className="label">
              {isPlatform ? 'Search platform…' : 'Search or ask Ratio to do something…'}
            </span>
            <span className="kbd">⌘K</span>
          </button>
          <div className="right">
            <button className="btn btn-ghost" onClick={cycle}>
              {resolved === 'dark' ? 'Light' : 'Dark'}
            </button>
            {isPlatform ? (
              <button className="btn btn-ghost" onClick={() => setRoute('home')}>
                Merchant view
              </button>
            ) : (
              <button
                className={showAsk ? 'btn btn-primary' : 'btn btn-ghost'}
                onClick={() => setAskOpen((o) => !o)}
              >
                Ask Ratio
              </button>
            )}
            <UserButton afterSignOutUrl="/" />
          </div>
        </header>

        <div className={showAsk ? 'shell-body with-ask' : 'shell-body'}>
          <main
            className="container"
            style={{ overflow: 'auto', outline: 'none' }}
            ref={mainRef}
            tabIndex={-1}
          >
            {current && renderRoute(route, current, nav)}
          </main>
          {showAsk && (
            <>
              {/* Click-away backdrop only when the rail is an overlay drawer (< 1200px). */}
              {narrow && (
                <div className="ask-backdrop" onClick={() => setAskOpen(false)} aria-hidden />
              )}
              <AskRatio
                api={api}
                storeId={current?.id ?? null}
                overlay={narrow}
                onChanged={onChanged}
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
