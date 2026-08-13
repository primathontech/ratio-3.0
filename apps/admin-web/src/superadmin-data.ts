// Placeholder metrics for the platform-admin "Merchants" view. Real stores carry no GMV / health /
// plan yet (analytics lives outside this DB — ADR-017), so we synthesize DETERMINISTIC numbers from
// the store id: stable across renders, obviously demo-grade, wired to real data later. The platform
// KPI + incident strips are static demo content.
import type { Store } from './api';

export type StatusKey = 'live' | 'review' | 'risk' | 'onboarding';
export const MERCHANT_STATUS: Record<
  StatusKey,
  { label: string; tone: 'ok' | 'warn' | 'err' | '' }
> = {
  live: { label: 'Live', tone: 'ok' },
  review: { label: 'In review', tone: 'warn' },
  risk: { label: 'At risk', tone: 'err' },
  onboarding: { label: 'Onboarding', tone: '' },
};

export interface Merchant {
  store: Store;
  name: string;
  domain: string;
  plan: 'Starter' | 'Growth' | 'Enterprise';
  gmv: string;
  orders: string;
  health: number;
  status: StatusKey;
  since: string;
  owner: string;
  location: string;
  spark: number[];
}

const PLANS = ['Starter', 'Growth', 'Enterprise'] as const;
const OWNERS = [
  'Ari Reyes',
  'Dana Whitfield',
  'Priya Menon',
  'Tom Baird',
  'Nour Haddad',
  'Iris Nakamura',
];
const CITIES = [
  'Lisbon, PT',
  'Toronto, CA',
  'Austin, US',
  'Berlin, DE',
  'Osaka, JP',
  'Auckland, NZ',
];
const MONTHS = ['Jan', 'Mar', 'Jun', 'Aug', 'Sep', 'Nov'];

// FNV-1a → xorshift: a tiny deterministic PRNG seeded by the store id.
function rng(id: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = h >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1000) / 1000;
  };
}
const pick = <T>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)];

function domainOf(store: Store): string {
  const hosts = store.hosts ?? (store.host ? [store.host] : []);
  return hosts.find((h) => !h.endsWith('.localhost')) ?? hosts[0] ?? 'no domain';
}

export function merchantOf(store: Store): Merchant {
  const r = rng(store.id);
  const health = 42 + Math.floor(r() * 57); // 42–98
  const status: StatusKey = health >= 82 ? 'live' : health >= 56 ? 'review' : 'risk';
  const gmvNum = 20_000 + Math.floor(r() * 1_480_000);
  return {
    store,
    name: store.name,
    domain: domainOf(store),
    plan: pick(r, PLANS),
    gmv: '$' + gmvNum.toLocaleString('en-US'),
    orders: (100 + Math.floor(r() * 9700)).toLocaleString('en-US'),
    health,
    status,
    since: `${pick(r, MONTHS)} ${2021 + Math.floor(r() * 5)}`,
    owner: pick(r, OWNERS),
    location: pick(r, CITIES),
    spark: Array.from({ length: 12 }, () => 22 + Math.floor(r() * 74)),
  };
}

export const PLATFORM_KPI = [
  {
    label: 'Platform GMV',
    value: '$18.4M',
    delta: '+11.2%',
    dir: 'up' as const,
    spark: [42, 48, 46, 54, 58, 56, 66, 70, 68, 78, 84, 92],
  },
  {
    label: 'Active merchants',
    value: '',
    delta: '+96',
    dir: 'up' as const,
    spark: [36, 42, 40, 48, 52, 50, 58, 62, 60, 68, 72, 80],
  },
  {
    label: 'Net MRR',
    value: '$742k',
    delta: '+4.8%',
    dir: 'up' as const,
    spark: [50, 54, 52, 58, 56, 64, 62, 68, 66, 74, 72, 80],
  },
  {
    label: 'Take rate',
    value: '2.31%',
    delta: '-0.04pt',
    dir: 'down' as const,
    spark: [64, 60, 62, 58, 60, 56, 54, 52, 50, 48, 46, 44],
  },
  {
    label: 'Merchants at risk',
    value: '',
    delta: '+6',
    dir: 'down' as const,
    spark: [24, 28, 26, 34, 32, 40, 38, 46, 44, 52, 50, 58],
  },
];

export const INCIDENTS = [
  {
    title: 'Payouts delayed — EU region',
    note: 'Investigating · 22 merchants affected',
    tone: 'warn',
    when: '14m ago',
  },
  {
    title: 'Checkout API p95 at 480ms',
    note: 'Monitoring · degraded since 09:12',
    tone: 'warn',
    when: '1h ago',
  },
  {
    title: 'Fraud rules v14 rolled out',
    note: 'Resolved · false positives down 31%',
    tone: 'ok',
    when: 'Yesterday',
  },
];
