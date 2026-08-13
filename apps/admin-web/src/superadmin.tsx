import { useMemo, useState } from 'react';
import type { Store } from './api';
import { useToast } from './ui';
import {
  merchantOf,
  MERCHANT_STATUS,
  PLATFORM_KPI,
  INCIDENTS,
  type Merchant,
} from './superadmin-data';

const FILTERS: Record<string, (m: Merchant) => boolean> = {
  All: () => true,
  Enterprise: (m) => m.plan === 'Enterprise',
  'In review': (m) => m.status === 'review',
  'At risk': (m) => m.status === 'risk',
  Onboarding: (m) => m.status === 'onboarding',
};

const initials = (name: string) =>
  (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('') || '?'
  ).toUpperCase();

const healthColor = (h: number) =>
  h >= 85 ? 'var(--success)' : h >= 60 ? 'var(--warning)' : 'var(--danger)';
const pillClass = (tone: string) =>
  tone === 'ok'
    ? 'pill pill-ok'
    : tone === 'warn'
      ? 'pill pill-warn'
      : tone === 'err'
        ? 'pill pill-err'
        : 'pill';

function Spark({ values, height = 28 }: { values: number[]; height?: number }) {
  return (
    <div className="spark" style={{ height }}>
      {values.map((h, i) => (
        <span
          key={i}
          className={i >= values.length - 3 ? 'lead' : ''}
          style={{ height: `${h}%` }}
        />
      ))}
    </div>
  );
}

// Platform-admin "Merchants" view (reference SuperAdmin screen). Real stores + deterministic
// placeholder metrics from superadmin-data. Row select fills the detail rail; "Enter store" opens
// the store (our real open flow); "Invite merchant" opens the real create-store dialog.
export function SuperAdmin({
  stores,
  onOpen,
  onCreate,
}: {
  stores: Store[];
  onOpen: (s: Store) => void;
  onCreate: () => void;
}) {
  const toast = useToast();
  const merchants = useMemo(() => stores.map(merchantOf), [stores]);
  const [tab, setTab] = useState('All');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return merchants
      .filter(FILTERS[tab])
      .filter((m) => !q || `${m.name} ${m.domain} ${m.owner} ${m.plan}`.toLowerCase().includes(q));
  }, [merchants, tab, query]);

  const tabs = Object.keys(FILTERS).map((label) => ({
    label,
    count: merchants.filter(FILTERS[label]).length,
  }));
  const current =
    merchants.find((m) => m.store.id === selectedId) ?? rows[0] ?? merchants[0] ?? null;

  const kpis = PLATFORM_KPI.map((k) =>
    k.label === 'Active merchants'
      ? { ...k, value: String(merchants.length) }
      : k.label === 'Merchants at risk'
        ? { ...k, value: String(merchants.filter((m) => m.status === 'risk').length) }
        : k
  );

  return (
    <div className="sa-grid fade-in">
      <div className="sa-main">
        <div className="page-head">
          <div className="head-text">
            <h1>Merchants</h1>
            <p>Every store on Ratio, their health, and what needs a human today.</p>
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => toast('Export queued — we’ll email the CSV')}
          >
            Export
          </button>
          <button className="btn btn-primary" onClick={onCreate}>
            Invite merchant
          </button>
        </div>

        <div className="kpi-grid">
          {kpis.map((k) => (
            <div className="kpi-card" key={k.label}>
              <div className="kpi-label">{k.label}</div>
              <div className="kpi-value-row">
                <span className="kpi-value">{k.value}</span>
                <span className={k.dir === 'up' ? 'kpi-delta up' : 'kpi-delta down'}>
                  {k.delta}
                </span>
              </div>
              <Spark values={k.spark} />
            </div>
          ))}
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
            <div className="seg">
              {tabs.map((t) => (
                <button
                  key={t.label}
                  className={t.label === tab ? 'on' : ''}
                  onClick={() => setTab(t.label)}
                >
                  {t.label}{' '}
                  <span style={{ color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>
                    {t.count}
                  </span>
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
              {rows.length} of {merchants.length} merchants
            </span>
            <input
              className="input"
              style={{ width: 240, height: 34 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by store, owner, domain…"
              aria-label="Filter merchants"
            />
          </div>

          <div className="table-wrap">
            <table className="data-table" style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Plan</th>
                  <th className="num">GMV · 30d</th>
                  <th className="num">Orders</th>
                  <th className="num">Health</th>
                  <th>Status</th>
                  <th className="num">Since</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const s = MERCHANT_STATUS[m.status];
                  const active = current?.store.id === m.store.id;
                  return (
                    <tr
                      key={m.store.id}
                      onClick={() => setSelectedId(m.store.id)}
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
                            {initials(m.name)}
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
                              {m.name}
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
                              {m.domain}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td style={{ color: 'var(--muted)' }}>{m.plan}</td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {m.gmv}
                      </td>
                      <td className="num" style={{ color: 'var(--muted)' }}>
                        {m.orders}
                      </td>
                      <td className="num">
                        <span className="health">
                          <span className="health-track">
                            <span
                              className="health-fill"
                              style={{ width: `${m.health}%`, background: healthColor(m.health) }}
                            />
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{m.health}</span>
                        </span>
                      </td>
                      <td>
                        <span className={pillClass(s.tone)}>{s.label}</span>
                      </td>
                      <td className="num" style={{ color: 'var(--text-3)', fontSize: 12 }}>
                        {m.since}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {current && (
        <DetailRail
          m={current}
          onOpen={onOpen}
          onFlag={() => toast(`${current.name} flagged for compliance review`)}
        />
      )}
    </div>
  );
}

function DetailRail({
  m,
  onOpen,
  onFlag,
}: {
  m: Merchant;
  onOpen: (s: Store) => void;
  onFlag: () => void;
}) {
  const s = MERCHANT_STATUS[m.status];
  const detail: [string, string][] = [
    ['Plan', m.plan],
    ['GMV · 30d', m.gmv],
    ['Orders · 30d', m.orders],
    ['Owner', m.owner],
    ['Location', m.location],
    ['Merchant since', m.since],
    ['Payout method', 'Ratio Payments'],
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
            {initials(m.name)}
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>
              {m.name}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{m.domain}</span>
          </span>
          <span className={pillClass(s.tone)}>{s.label}</span>
        </div>
        <Spark values={m.spark} height={44} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => onOpen(m.store)}>
            Enter store
          </button>
          <button className="btn btn-ghost" onClick={onFlag}>
            Flag
          </button>
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

      <div className="sa-rail-sec">
        <div style={{ fontSize: 13, fontWeight: 600 }}>Platform status</div>
        {INCIDENTS.map((i) => (
          <div className="incident" key={i.title}>
            <span
              className="dot"
              style={{ background: i.tone === 'ok' ? 'var(--success)' : 'var(--warning)' }}
            />
            <span
              style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}
            >
              <span style={{ fontSize: 13, fontWeight: 500 }}>{i.title}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i.note}</span>
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
              {i.when}
            </span>
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
