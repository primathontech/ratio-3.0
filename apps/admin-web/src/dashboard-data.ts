// Placeholder analytics for the merchant Dashboard "home" (reference Sophie screen). No orders /
// revenue data exists in this control-plane DB (analytics lives elsewhere — ADR-017), so these are
// static demo numbers for visual parity, wired to a real source later.
export type RangeKey = '24h' | '7d' | '30d' | '12m';

export const RANGES: { value: RangeKey; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '12m', label: '12 months' },
];
export const RANGE_LABEL: Record<RangeKey, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days vs previous 7',
  '30d': 'Last 30 days',
  '12m': 'Last 12 months',
};

export interface Kpi {
  label: string;
  value: string;
  delta: string;
  dir: 'up' | 'down';
  spark: number[];
}
export const KPI: Record<RangeKey, Kpi[]> = {
  '24h': [
    {
      label: 'Revenue today',
      value: '$12,480',
      delta: '+12.4%',
      dir: 'up',
      spark: [40, 52, 38, 60, 72, 58, 80, 66, 90, 74, 84, 96],
    },
    {
      label: 'Conversion rate',
      value: '3.42%',
      delta: '+0.31pt',
      dir: 'up',
      spark: [30, 44, 36, 50, 42, 58, 52, 64, 60, 72, 68, 78],
    },
    {
      label: 'Average order value',
      value: '$96.40',
      delta: '-2.1%',
      dir: 'down',
      spark: [70, 64, 72, 58, 66, 54, 60, 50, 56, 48, 52, 44],
    },
    {
      label: 'Orders',
      value: '129',
      delta: '+18',
      dir: 'up',
      spark: [34, 40, 52, 46, 58, 64, 60, 72, 68, 80, 76, 88],
    },
    {
      label: 'Returning customers',
      value: '41%',
      delta: '+3.0pt',
      dir: 'up',
      spark: [44, 48, 42, 56, 52, 60, 58, 66, 62, 70, 68, 74],
    },
  ],
  '7d': [
    {
      label: 'Revenue',
      value: '$86,204',
      delta: '+9.8%',
      dir: 'up',
      spark: [44, 50, 42, 58, 66, 60, 74, 70, 82, 78, 88, 94],
    },
    {
      label: 'Conversion rate',
      value: '3.18%',
      delta: '+0.12pt',
      dir: 'up',
      spark: [32, 40, 38, 46, 44, 54, 50, 60, 58, 66, 64, 72],
    },
    {
      label: 'Average order value',
      value: '$98.10',
      delta: '+1.4%',
      dir: 'up',
      spark: [50, 54, 48, 60, 56, 64, 60, 68, 66, 72, 70, 78],
    },
    {
      label: 'Orders',
      value: '879',
      delta: '+64',
      dir: 'up',
      spark: [36, 42, 50, 48, 56, 62, 58, 70, 66, 78, 74, 84],
    },
    {
      label: 'Returning customers',
      value: '38%',
      delta: '+1.2pt',
      dir: 'up',
      spark: [42, 46, 44, 52, 50, 58, 56, 62, 60, 68, 66, 72],
    },
  ],
  '30d': [
    {
      label: 'Revenue',
      value: '$341,900',
      delta: '+14.2%',
      dir: 'up',
      spark: [38, 46, 44, 54, 62, 58, 70, 68, 80, 76, 86, 92],
    },
    {
      label: 'Conversion rate',
      value: '3.06%',
      delta: '-0.08pt',
      dir: 'down',
      spark: [60, 56, 58, 52, 54, 48, 50, 46, 44, 42, 40, 38],
    },
    {
      label: 'Average order value',
      value: '$101.20',
      delta: '+3.6%',
      dir: 'up',
      spark: [46, 52, 50, 58, 56, 64, 62, 70, 68, 74, 72, 80],
    },
    {
      label: 'Orders',
      value: '3,378',
      delta: '+402',
      dir: 'up',
      spark: [34, 40, 48, 46, 56, 60, 58, 68, 66, 76, 74, 82],
    },
    {
      label: 'Returning customers',
      value: '36%',
      delta: '+2.4pt',
      dir: 'up',
      spark: [40, 44, 42, 50, 48, 56, 54, 60, 58, 66, 64, 70],
    },
  ],
  '12m': [
    {
      label: 'Revenue',
      value: '$3.94M',
      delta: '+38%',
      dir: 'up',
      spark: [24, 32, 40, 38, 50, 58, 56, 68, 72, 80, 88, 96],
    },
    {
      label: 'Conversion rate',
      value: '2.94%',
      delta: '+0.44pt',
      dir: 'up',
      spark: [28, 34, 32, 42, 40, 50, 48, 58, 56, 66, 64, 72],
    },
    {
      label: 'Average order value',
      value: '$97.80',
      delta: '+6.2%',
      dir: 'up',
      spark: [42, 48, 46, 54, 52, 60, 58, 66, 64, 72, 70, 78],
    },
    {
      label: 'Orders',
      value: '40,281',
      delta: '+11,204',
      dir: 'up',
      spark: [20, 28, 36, 34, 46, 54, 52, 64, 68, 76, 84, 92],
    },
    {
      label: 'Returning customers',
      value: '34%',
      delta: '+5.1pt',
      dir: 'up',
      spark: [30, 36, 34, 44, 42, 52, 50, 58, 56, 64, 62, 70],
    },
  ],
};

// [label, thisPeriod%, previous%]
export const CHART: Record<RangeKey, [string, number, number][]> = {
  '24h': [
    ['00', 30, 26],
    ['04', 18, 22],
    ['08', 44, 38],
    ['12', 72, 58],
    ['16', 88, 70],
    ['20', 64, 66],
    ['23', 40, 44],
  ],
  '7d': [
    ['Mon', 54, 48],
    ['Tue', 62, 52],
    ['Wed', 48, 56],
    ['Thu', 78, 60],
    ['Fri', 96, 74],
    ['Sat', 84, 80],
    ['Sun', 68, 62],
  ],
  '30d': [
    ['W1', 46, 52],
    ['W2', 58, 50],
    ['W3', 72, 60],
    ['W4', 90, 68],
    ['W5', 76, 70],
    ['W6', 64, 58],
    ['W7', 82, 66],
  ],
  '12m': [
    ['Q1', 40, 34],
    ['Q2', 58, 46],
    ['Q3', 74, 60],
    ['Q4', 96, 78],
    ['Q1b', 62, 58],
    ['Q2b', 70, 64],
    ['Q3b', 88, 72],
  ],
};

export const LIVE_VISITORS: Record<RangeKey, number> = {
  '24h': 184,
  '7d': 212,
  '30d': 198,
  '12m': 205,
};

export const TRAFFIC_SOURCES: { label: string; pct: number; color: string }[] = [
  { label: 'Instagram', pct: 42, color: 'var(--accent)' },
  { label: 'Direct', pct: 27, color: 'var(--success)' },
  { label: 'Google', pct: 19, color: 'var(--warning)' },
  { label: 'Email', pct: 12, color: 'var(--text-3)' },
];

export const CHECKLIST: { key: string; label: string }[] = [
  { key: 'products', label: 'Add products' },
  { key: 'payments', label: 'Configure payments' },
  { key: 'shipping', label: 'Set shipping' },
  { key: 'publish', label: 'Publish store' },
];

export const ORDERS: {
  id: string;
  customer: string;
  status: string;
  payment: string;
  fulfillment: string;
  total: string;
  date: string;
  tone: 'ok' | 'warn' | 'err' | '';
}[] = [
  {
    id: '#R-4821',
    customer: 'Maya Rowen',
    status: 'Paid',
    payment: 'Card · Visa',
    fulfillment: 'Unfulfilled',
    total: '$248.00',
    date: '2:14 PM',
    tone: 'warn',
  },
  {
    id: '#R-4820',
    customer: 'Devin Cole',
    status: 'Fulfilled',
    payment: 'UPI',
    fulfillment: 'Shipped',
    total: '$92.50',
    date: '1:48 PM',
    tone: 'ok',
  },
  {
    id: '#R-4819',
    customer: 'Iris Nakamura',
    status: 'Paid',
    payment: 'Card · Amex',
    fulfillment: 'Ready to ship',
    total: '$412.00',
    date: '1:02 PM',
    tone: 'warn',
  },
  {
    id: '#R-4818',
    customer: 'Theo Alvarez',
    status: 'Refunded',
    payment: 'Card · Visa',
    fulfillment: 'Returned',
    total: '$68.00',
    date: '12:20 PM',
    tone: 'err',
  },
  {
    id: '#R-4817',
    customer: 'Nour Haddad',
    status: 'Fulfilled',
    payment: 'GoKwik',
    fulfillment: 'Delivered',
    total: '$156.25',
    date: '11:47 AM',
    tone: 'ok',
  },
];

// Sidebar nav. `real: true` routes render a live panel; the rest are ComingSoon placeholders.
export interface NavItem {
  label: string;
  route: string;
  hint?: string;
  real?: boolean;
  ownerOnly?: boolean;
  adminOnly?: boolean;
}
export const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'Store',
    items: [
      { label: 'Home', route: 'home', hint: 'G H', real: true },
      { label: 'Orders', route: 'orders', hint: 'G O' },
      { label: 'Products', route: 'products', hint: 'G P' },
      { label: 'Customers', route: 'customers' },
    ],
  },
  {
    title: 'Grow',
    items: [
      { label: 'Analytics', route: 'analytics' },
      { label: 'Marketing', route: 'marketing' },
      { label: 'Discounts', route: 'discounts' },
    ],
  },
  {
    title: 'Storefront',
    items: [
      { label: 'Pages', route: 'pages', real: true },
      // Theme also holds version history (published/rollback) as a tab.
      { label: 'Theme', route: 'theme', hint: 'G T', real: true },
      { label: 'Domains', route: 'domains', real: true },
    ],
  },
  {
    title: 'Settings',
    items: [
      { label: 'Payments', route: 'commerce', real: true, ownerOnly: true },
      { label: 'Developers', route: 'access', real: true },
      { label: 'Activity', route: 'audit', real: true },
    ],
  },
];
