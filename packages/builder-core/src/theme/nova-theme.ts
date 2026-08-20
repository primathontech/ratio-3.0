import type { ThemeFiles } from './bundle';
import { defaultBundleTheme } from './default-theme';

// "Nova" base — bold, modern, made for D2C / fashion. Shared chrome from the Default base, but a
// punchy home: a dark full-bleed hero with oversized type, a row of bold category tiles, and a "New
// drops" product row. Authored as the Default base composed with only its distinctive files.

// Bold sans, larger type, soft corners.
const TOKENS = {
  bodyFont: 'sans',
  headingFont: 'sans',
  baseSize: 'l',
  radius: 'soft',
  container: 'normal',
};

const INDEX = {
  dataSources: { all: { type: 'PRODUCTS', params: { first: 8 } } },
  sections: [
    {
      type: 'nova-hero',
      data: {
        kicker: 'New season · 2025',
        heading: 'Wear the drop.',
        subheading: 'Limited runs, bold silhouettes, and colours that do the talking.',
        cta_label: 'Shop new in',
        cta_href: '/collections/all',
      },
    },
    {
      type: 'tiles',
      data: {
        heading: 'Shop by category',
        t1_label: 'New in',
        t1_href: '/collections/all',
        t2_label: 'Bestsellers',
        t2_href: '/collections/all',
        t3_label: 'Sale',
        t3_href: '/collections/all',
      },
    },
    { type: 'collection-row', dataSourceKey: 'all', data: { heading: 'New drops' } },
    { type: 'brand-story' },
  ],
};

const NOVA_HERO = `<section class="nova-hero">
  <div class="rt nova-hero-in">
    {% if kicker %}<span class="nova-kicker">{{ kicker | escape }}</span>{% endif %}
    <h1 class="nova-title">{{ heading | escape }}</h1>
    {% if subheading %}<p class="nova-sub">{{ subheading | escape }}</p>{% endif %}
    {% if cta_label %}<a class="btn nova-cta" href="{{ cta_href | default: '/collections/all' | escape }}">{{ cta_label | escape }}</a>{% endif %}
  </div>
</section>
`;

const TILES = `<section class="rt">
  {% if heading %}<h2 class="heading">{{ heading | escape }}</h2>{% endif %}
  <div class="tiles">
    <a class="tile" href="{{ t1_href | default: '/collections/all' | escape }}"><span>{{ t1_label | default: 'New in' | escape }}</span></a>
    <a class="tile" href="{{ t2_href | default: '/collections/all' | escape }}"><span>{{ t2_label | default: 'Bestsellers' | escape }}</span></a>
    <a class="tile" href="{{ t3_href | default: '/collections/all' | escape }}"><span>{{ t3_label | default: 'Sale' | escape }}</span></a>
  </div>
</section>
`;

const NOVA_CSS = `
/* Nova base sections */
.nova-hero{background:var(--ink);color:#fff;padding:104px 0}
.nova-hero-in{max-width:820px}
.nova-kicker{display:inline-block;font-size:.8rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.7;margin-bottom:16px}
.nova-title{font-size:clamp(2.8rem,8vw,5.5rem);line-height:.98;letter-spacing:-.03em;margin:0 0 18px;text-wrap:balance}
.nova-sub{font-size:1.2rem;opacity:.82;max-width:46ch;margin:0 0 28px}
.nova-cta{background:#fff;color:var(--ink)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:6px 0 36px}
.tile{aspect-ratio:4/3;display:flex;align-items:flex-end;padding:18px;background:var(--surface);border-radius:var(--radius);font-weight:700;font-size:1.15rem;transition:filter .15s}
.tile:hover{filter:brightness(.97)}
@media (max-width:720px){.tiles{grid-template-columns:1fr}.nova-hero{padding:72px 0}}
`;

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export function novaBundleTheme(): ThemeFiles {
  const base = defaultBundleTheme();
  return {
    ...base,
    'config/tokens.json': json(TOKENS),
    'templates/index.json': json(INDEX),
    'sections/nova-hero.liquid': NOVA_HERO,
    'sections/tiles.liquid': TILES,
    'assets/base.css': `${base['assets/base.css']}\n${NOVA_CSS}`,
  };
}
