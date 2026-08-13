import { useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import {
  CHART,
  CHECKLIST,
  KPI,
  LIVE_VISITORS,
  ORDERS,
  RANGES,
  RANGE_LABEL,
  TRAFFIC_SOURCES,
  type RangeKey,
} from './dashboard-data';

function Spark({ values }: { values: number[] }) {
  return (
    <div className="spark">
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

const pillClass = (tone: string) =>
  tone === 'ok'
    ? 'pill pill-ok'
    : tone === 'warn'
      ? 'pill pill-warn'
      : tone === 'err'
        ? 'pill pill-err'
        : 'pill';
const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

// The merchant "home" — reference Sophie dashboard. All numbers are placeholder demo data (see
// dashboard-data). `storeName` and the range are the only live bits of state.
export function DashboardHome({ storeName }: { storeName: string }) {
  const { user } = useUser();
  const firstName = user?.firstName;
  const [range, setRange] = useState<RangeKey>('7d');
  const [done, setDone] = useState<Record<string, boolean>>({ products: true });
  const pct = Math.round((Object.values(done).filter(Boolean).length / CHECKLIST.length) * 100);
  const bars = CHART[range];

  return (
    <div className="dash fade-in">
      <div className="page-head">
        <div className="head-text">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1>Welcome{firstName ? `, ${firstName}` : ''}</h1>
            <span className="badge" title="Placeholder demo figures — not real analytics yet.">
              Sample data
            </span>
          </div>
          <p>
            Ratio watched <strong>{storeName}</strong> overnight. Revenue is pacing 12% ahead of
            last week.
          </p>
        </div>
        <div className="seg">
          {RANGES.map((r) => (
            <button
              key={r.value}
              className={r.value === range ? 'on' : ''}
              aria-pressed={r.value === range}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="kpi-grid">
        {KPI[range].map((k) => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value-row">
              <span className="kpi-value">{k.value}</span>
              <span className={k.dir === 'up' ? 'kpi-delta up' : 'kpi-delta down'}>{k.delta}</span>
            </div>
            <Spark values={k.spark} />
          </div>
        ))}
      </div>

      <div className="dash-cols">
        <div
          className="card"
          style={{ padding: '18px 20px 14px', display: 'flex', flexDirection: 'column', gap: 16 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: 20 }}>Sales</h3>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{RANGE_LABEL[range]}</span>
            <div style={{ flex: 1 }} />
            <span className="legend">
              <span className="sw" style={{ background: 'var(--accent)' }} />
              This period
            </span>
            <span className="legend">
              <span className="sw" style={{ background: 'var(--surface-3)' }} />
              Previous
            </span>
          </div>
          <div className="chart">
            {bars.map(([label, now, prev], i) => (
              <div className="chart-col" key={label + i}>
                <div className="chart-tip">{i === 4 ? '$18.2k' : ''}</div>
                <div className="chart-bars">
                  <span
                    className="bar"
                    style={{ height: `${prev}%`, background: 'var(--surface-3)' }}
                  />
                  <span
                    className="bar"
                    style={{ height: `${now}%`, background: 'var(--accent)' }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="chart-labels">
            {bars.map(([label], i) => (
              <div key={label + i}>{label.replace(/b$/, '')}</div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ padding: '16px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span className="live-dot" />
              <span style={{ fontSize: 13, fontWeight: 600 }}>Live visitors</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 24, fontWeight: 640, letterSpacing: '-0.02em' }}>
                {LIVE_VISITORS[range]}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {TRAFFIC_SOURCES.map((s) => (
                <div key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ display: 'flex', fontSize: 12, color: 'var(--muted)' }}>
                    <span style={{ flex: 1 }}>{s.label}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{s.pct}%</span>
                  </div>
                  <div className="meter">
                    <span style={{ width: `${s.pct}%`, background: s.color }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            className="card"
            style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>Launch checklist</div>
            {CHECKLIST.map((c) => {
              const isDone = !!done[c.key];
              return (
                <button
                  key={c.key}
                  className="checkitem"
                  onClick={() => setDone((d) => ({ ...d, [c.key]: !d[c.key] }))}
                >
                  <span className={isDone ? 'checkbox on' : 'checkbox'}>{isDone ? '✓' : ''}</span>
                  <span
                    style={{
                      flex: 1,
                      color: isDone ? 'var(--text-3)' : 'var(--text)',
                      textDecoration: isDone ? 'line-through' : 'none',
                    }}
                  >
                    {c.label}
                  </span>
                </button>
              );
            })}
            <div className="meter">
              <span style={{ width: `${pct}%`, background: 'var(--success)' }} />
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <h3 style={{ fontSize: 20 }}>Recent orders</h3>
          <span className="pill pill-warn">3 need review</span>
        </div>
        <div className="table-wrap">
          <table className="data-table" style={{ minWidth: 780 }}>
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Fulfillment</th>
                <th className="num">Total</th>
                <th className="num">Date</th>
              </tr>
            </thead>
            <tbody>
              {ORDERS.map((o) => (
                <tr key={o.id}>
                  <td className="id">{o.id}</td>
                  <td>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                      <span
                        className="avatar"
                        style={{ width: 24, height: 24, fontSize: 10 }}
                        aria-hidden
                      >
                        {initials(o.customer)}
                      </span>
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {o.customer}
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className={pillClass(o.tone)}>{o.status}</span>
                  </td>
                  <td style={{ color: 'var(--muted)' }}>{o.payment}</td>
                  <td style={{ color: 'var(--muted)' }}>{o.fulfillment}</td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {o.total}
                  </td>
                  <td className="num" style={{ color: 'var(--text-3)', fontSize: 12 }}>
                    {o.date}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
