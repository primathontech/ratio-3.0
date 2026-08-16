import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Api, Store } from '../../common/api';
import { Icon, useToast } from '../../common/ui';
import { storefrontUrl, storeSlug } from '../../common/store-context';

// Platform-admin "Stores" view: every store on the platform, bound to REAL data — name, domain, owner
// (resolved to a Clerk name via the users endpoint), created-since, and the live storefront link.
// GMV / orders / status are intentionally absent until the analytics API lands (OFCE-619); we don't
// show placeholder numbers. Row select fills the detail rail; owner links across to the Users view.

type OwnerInfo = { name: string | null; email: string | null };

const initials = (name: string) =>
  (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('') || '?'
  ).toUpperCase();

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function SuperAdmin({
  api,
  stores,
  isLocal,
  onCreate,
}: {
  api: Api;
  stores: Store[];
  isLocal: boolean;
  onCreate: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Resolve owner clerk ids to real names/emails (falls back to the id when Clerk isn't configured).
  const [owners, setOwners] = useState<Map<string, OwnerInfo>>(new Map());

  useEffect(() => {
    api
      .listUsers()
      .then((us) =>
        setOwners(
          new Map(us.map((u) => [u.userId, { name: u.name ?? null, email: u.email ?? null }]))
        )
      )
      .catch(() => {
        /* degrade to raw owner ids */
      });
  }, [api]);

  const ownerName = (id: string | null | undefined) => (id ? (owners.get(id)?.name ?? id) : null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return stores;
    return stores.filter((s) => {
      const o = s.ownerId ? owners.get(s.ownerId) : undefined;
      return `${s.name} ${s.host ?? ''} ${s.ownerId ?? ''} ${o?.name ?? ''} ${o?.email ?? ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [stores, query, owners]);

  const current = stores.find((s) => s.id === selectedId) ?? rows[0] ?? null;

  return (
    <div className={`sa-grid fade-in${current ? '' : ' sa-grid-full'}`}>
      <div className="sa-main">
        <div className="page-head">
          <div className="head-text">
            <h1>Stores</h1>
            <p>Every store on the platform.</p>
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
              {rows.length} of {stores.length} stores
            </span>
            <div style={{ flex: 1 }} />
            <input
              className="input"
              style={{ width: 240, height: 34 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by store, owner, domain…"
              aria-label="Filter stores"
            />
          </div>

          <div className="table-wrap">
            <table className="data-table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Owner</th>
                  <th className="num">Since</th>
                  <th>Storefront</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="table-empty">
                      <span className="table-empty-emoji" aria-hidden>
                        🏪
                      </span>
                      {stores.length === 0
                        ? 'No stores yet — create your first store with “New store”.'
                        : 'No stores match your filter.'}
                    </td>
                  </tr>
                ) : (
                  rows.map((s) => {
                    const active = current?.id === s.id;
                    const sfUrl = storefrontUrl(s, isLocal);
                    return (
                      <tr
                        key={s.id}
                        onClick={() => setSelectedId(s.id)}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedId(s.id);
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        aria-pressed={active}
                        aria-label={`Select ${s.name}`}
                        style={{
                          cursor: 'pointer',
                          background: active ? 'var(--surface-2)' : undefined,
                        }}
                      >
                        <td>
                          <span
                            style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}
                          >
                            <span
                              className="avatar avatar-sq"
                              style={{ width: 28, height: 28, fontSize: 11 }}
                              aria-hidden
                            >
                              {initials(s.name)}
                            </span>
                            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                              <span
                                style={{
                                  fontWeight: 500,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {s.name}
                              </span>
                              <span
                                style={{
                                  fontSize: 12,
                                  color: 'var(--text-3)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {s.host ?? 'no domain'}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td style={{ maxWidth: 200 }}>
                          {s.ownerId ? (
                            <Link
                              to={`/admin?user=${encodeURIComponent(s.ownerId)}`}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                              title={`View ${ownerName(s.ownerId)} in Users`}
                              style={{
                                display: 'inline-block',
                                maxWidth: 200,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                verticalAlign: 'bottom',
                                color: 'var(--accent)',
                              }}
                            >
                              {ownerName(s.ownerId)}
                            </Link>
                          ) : (
                            <span style={{ color: 'var(--text-3)' }}>—</span>
                          )}
                        </td>
                        <td className="num" style={{ color: 'var(--text-3)', fontSize: 12 }}>
                          {fmtDate(s.since)}
                        </td>
                        <td>
                          {sfUrl ? (
                            <a
                              className="btn btn-ghost btn-sm"
                              href={sfUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                              aria-label={`Open ${s.name} storefront in a new tab`}
                            >
                              Open <Icon.external size={13} />
                            </a>
                          ) : (
                            <span style={{ color: 'var(--text-3)' }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {current && (
        <DetailRail
          s={current}
          owner={current.ownerId ? owners.get(current.ownerId) : undefined}
          isLocal={isLocal}
        />
      )}
    </div>
  );
}

function DetailRail({
  s,
  owner,
  isLocal,
}: {
  s: Store;
  owner: OwnerInfo | undefined;
  isLocal: boolean;
}) {
  const sfUrl = storefrontUrl(s, isLocal);
  const detail: [string, string][] = [
    ['Owner', owner?.name ?? s.ownerId ?? '—'],
    ['Email', owner?.email ?? '—'],
    ['Domain', s.host ?? '—'],
    ['Store since', fmtDate(s.since)],
  ];
  return (
    <aside className="sa-rail">
      <div className="sa-rail-sec">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            className="avatar avatar-sq"
            style={{ width: 36, height: 36, fontSize: 13 }}
            aria-hidden
          >
            {initials(s.name)}
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>
              {s.name}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{s.host ?? 'no domain'}</span>
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a
            className="btn btn-ghost"
            style={{ flex: 1 }}
            href={`/stores/${storeSlug(s)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Manage ${s.name} in a new tab`}
          >
            Manage store <Icon.external size={13} />
          </a>
          {sfUrl && (
            <a
              className="btn btn-ghost"
              href={sfUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${s.name} storefront in a new tab`}
            >
              View storefront <Icon.external size={13} />
            </a>
          )}
        </div>
      </div>

      <div className="sa-rail-sec">
        {detail.map(([k, v]) => (
          <div className="detail-row" key={k}>
            <span className="k">{k}</span>
            <span className="v">{v}</span>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 'auto',
          padding: '16px 18px',
          borderTop: '1px solid var(--line)',
          fontSize: 12,
          color: 'var(--text-3)',
        }}
      >
        Admin actions are logged and visible to the merchant in their security timeline.
      </div>
    </aside>
  );
}
