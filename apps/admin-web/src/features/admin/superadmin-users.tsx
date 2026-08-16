import { useEffect, useMemo, useState } from 'react';
import type { Api, PlatformUser } from '../../common/api';
import { Icon, Spinner, useToast } from '../../common/ui';
import { storeSlug } from '../../common/store-context';

// Platform-admin "Users" view: every registered person and the stores they run. Enriched with Clerk
// name/email when configured (falls back to store name + Clerk id otherwise); includes sign-ups with
// no store yet. Row select fills the detail rail; "Manage" opens that store's admin. Cross-links with
// the Stores view (owner → user).

// Initials from a display name ("Ada Lovelace" → "AL") or, lacking one, a Clerk id ("user_ab…" → "AB").
function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const s =
    words.length > 1
      ? words
          .map((w) => w[0])
          .slice(0, 2)
          .join('')
      : label.replace(/^user_/, '').slice(0, 2);
  return (s || '?').toUpperCase();
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function roleLabel(stores: { role: string }[]): string {
  const roles = Array.from(new Set(stores.map((s) => s.role)));
  if (roles.length === 0) return '—';
  return roles.length === 1 ? roles[0] : 'mixed';
}

// What to show as a user's primary/secondary label, given Clerk may or may not be wired.
const primaryLabel = (u: PlatformUser) => u.name || u.stores[0]?.name || u.userId;
const secondaryLabel = (u: PlatformUser) => u.email || u.userId;

export function SuperAdminUsers({ api, onCreate }: { api: Api; onCreate: () => void }) {
  const [users, setUsers] = useState<PlatformUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const toast = useToast();

  useEffect(() => {
    api
      .listUsers()
      .then(setUsers)
      .catch((e) => setError((e as Error).message));
  }, [api]);

  const rows = useMemo(() => {
    if (!users) return [];
    const q = query.trim().toLowerCase();
    return users.filter(
      (u) =>
        !q ||
        `${u.userId} ${u.name ?? ''} ${u.email ?? ''} ${u.stores.map((s) => s.name).join(' ')}`
          .toLowerCase()
          .includes(q)
    );
  }, [users, query]);

  const current = users?.find((u) => u.userId === selectedId) ?? rows[0] ?? null;

  if (!users && !error) {
    return (
      <div className="center-pad">
        <Spinner />
      </div>
    );
  }

  return (
    <div className={`sa-grid fade-in${current ? '' : ' sa-grid-full'}`}>
      <div className="sa-main">
        <div className="page-head">
          <div className="head-text">
            <h1>Users</h1>
            <p>Everyone with a store on Ratio, and what they run.</p>
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => toast('Export queued — we’ll email the CSV')}
          >
            Export
          </button>
          <button className="btn btn-primary" onClick={onCreate}>
            <Icon.plus /> New store
          </button>
        </div>

        {error ? (
          <div className="note note-error" role="alert">
            {error}
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {rows.length} of {users!.length} users
              </span>
              <div style={{ flex: 1 }} />
              <input
                className="input"
                style={{ width: 240, height: 34 }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by user or store…"
                aria-label="Filter users"
              />
            </div>

            <div className="table-wrap">
              <table className="data-table" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th>User</th>
                    <th className="num">Stores</th>
                    <th>Role</th>
                    <th className="num">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="table-empty">
                        <span className="table-empty-emoji" aria-hidden>
                          👥
                        </span>
                        {users!.length === 0 ? 'No users yet.' : 'No users match your filter.'}
                      </td>
                    </tr>
                  ) : (
                    rows.map((u) => {
                      const active = current?.userId === u.userId;
                      return (
                        <tr
                          key={u.userId}
                          onClick={() => setSelectedId(u.userId)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelectedId(u.userId);
                            }
                          }}
                          tabIndex={0}
                          role="button"
                          aria-pressed={active}
                          aria-label={`Select ${u.userId}`}
                          style={{
                            cursor: 'pointer',
                            background: active ? 'var(--surface-2)' : undefined,
                          }}
                        >
                          <td>
                            <span
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                minWidth: 0,
                              }}
                            >
                              <span
                                className="avatar avatar-sq"
                                style={{ width: 28, height: 28, fontSize: 11 }}
                                aria-hidden
                              >
                                {initials(u.name || u.userId)}
                              </span>
                              <span
                                style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
                              >
                                <span
                                  style={{
                                    fontWeight: 500,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {primaryLabel(u)}
                                </span>
                                <span
                                  className={u.email ? undefined : 'mono'}
                                  style={{
                                    fontSize: 12,
                                    color: 'var(--text-3)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {secondaryLabel(u)}
                                </span>
                              </span>
                            </span>
                          </td>
                          <td className="num" style={{ fontWeight: 600 }}>
                            {u.storeCount}
                          </td>
                          <td style={{ color: 'var(--muted)' }}>{roleLabel(u.stores)}</td>
                          <td className="num" style={{ color: 'var(--text-3)', fontSize: 12 }}>
                            {fmtDate(u.joined)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {current && <UserRail u={current} />}
    </div>
  );
}

function UserRail({ u }: { u: PlatformUser }) {
  return (
    <aside className="sa-rail">
      <div className="sa-rail-sec">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            className="avatar avatar-sq"
            style={{ width: 36, height: 36, fontSize: 13 }}
            aria-hidden
          >
            {initials(u.name || u.userId)}
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {primaryLabel(u)}
            </span>
            <span
              className={u.email ? undefined : 'mono'}
              style={{
                fontSize: 12,
                color: 'var(--text-3)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {secondaryLabel(u)}
            </span>
          </span>
        </div>
        <div className="detail-row">
          <span className="k">Stores</span>
          <span className="v">{u.storeCount}</span>
        </div>
        <div className="detail-row">
          <span className="k">Joined</span>
          <span className="v">{fmtDate(u.joined)}</span>
        </div>
      </div>

      <div className="sa-rail-sec">
        <div style={{ fontSize: 13, fontWeight: 600 }}>Stores</div>
        {u.stores.length === 0 && (
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>No stores yet.</span>
        )}
        {u.stores.map((s) => (
          <div className="incident" key={s.id}>
            <span
              style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.name}
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{s.role}</span>
            </span>
            <a
              className="btn btn-ghost btn-sm"
              href={`/stores/${storeSlug(s)}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Manage ${s.name}`}
            >
              Manage
            </a>
          </div>
        ))}
      </div>
    </aside>
  );
}
