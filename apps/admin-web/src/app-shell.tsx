import { useEffect, useMemo, useState } from 'react';
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
  const [route, setRoute] = useState('home');
  const [storeIdx, setStoreIdx] = useState(0);
  const [askOpen, setAskOpen] = useState(
    typeof window !== 'undefined' ? window.innerWidth >= 1280 : true
  );
  const [paletteOpen, setPaletteOpen] = useState(false);

  const current = stores[Math.min(storeIdx, stores.length - 1)];
  const owner = current?.role === 'owner';

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
      const i = stores.findIndex((x) => x.id === s.id);
      if (i >= 0) setStoreIdx(i);
      setRoute('home');
    },
  };

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

  const commands: Command[] = groups.flatMap((g) =>
    g.items.map((it) => ({
      label: `Go to ${it.label}`,
      group: g.title,
      run: () => setRoute(it.route),
    }))
  );

  const showAsk = askOpen && route !== 'admin';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="sidebar-brand"
          onClick={() => setStoreIdx((i) => (i + 1) % stores.length)}
        >
          <span className="logo">R</span>
          <span className="brand-meta">
            <span className="brand-name">{current?.name ?? 'Ratio'}</span>
            <span className="brand-sub">{owner ? 'Owner' : 'Member'}</span>
          </span>
          {stores.length > 1 && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>⌄</span>}
        </button>

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
              className={showAsk ? 'btn btn-primary' : 'btn btn-ghost'}
              onClick={() => setAskOpen((o) => !o)}
            >
              Ask Ratio
            </button>
            <UserButton afterSignOutUrl="/" />
          </div>
        </header>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: showAsk ? 'minmax(0,1fr) 344px' : 'minmax(0,1fr)',
          }}
        >
          <main className="container" style={{ overflow: 'auto' }}>
            {current && renderRoute(route, current, nav)}
          </main>
          {showAsk && (
            <AskRatio
              api={api}
              storeId={current?.id ?? null}
              onChanged={onChanged}
              onClose={() => setAskOpen(false)}
            />
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
