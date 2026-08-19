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
    title: 'Storefront',
    items: [
      { label: 'Themes', route: 'themes', hint: 'G T', real: true },
      { label: 'Pages', route: 'pages', real: true },
      { label: 'Domains', route: 'domains', real: true },
    ],
  },
  {
    title: 'Settings',
    items: [
      { label: 'Commerce', route: 'commerce', real: true, ownerOnly: true },
      { label: 'Activity', route: 'audit', real: true },
    ],
  },
];
