import type { ThemeFiles } from './bundle';
import { defaultBundleTheme } from './default-theme';

// "Aura" base — elegant, visual, made for beauty / lifestyle. Shared chrome from the Default base, but
// a soft, image-forward home: an airy centered hero, a two-panel image "duo", and a generous product
// row. Authored as the Default base composed with only its distinctive files.

// Serif headings over a sans body, rounded corners — soft and refined.
const TOKENS = {
  bodyFont: 'sans',
  headingFont: 'serif',
  baseSize: 'm',
  radius: 'rounded',
  container: 'normal',
};

const INDEX = {
  dataSources: { all: { type: 'PRODUCTS', params: { first: 8 } } },
  sections: [
    {
      type: 'aura-hero',
      data: {
        kicker: 'Skincare, simplified',
        heading: 'Glow, gently',
        subheading: 'Clean formulas and considered rituals for skin that feels like yours.',
        cta_label: 'Discover the range',
        cta_href: '/collections/all',
      },
    },
    {
      type: 'duo',
      data: {
        a_label: 'The ritual',
        a_href: '/collections/all',
        b_label: 'Bestsellers',
        b_href: '/collections/all',
      },
    },
    { type: 'collection-row', dataSourceKey: 'all', data: { heading: 'The collection' } },
    { type: 'brand-story' },
  ],
};

const AURA_HERO = `<section class="aura-hero">
  <div class="rt aura-hero-in">
    {% if kicker %}<span class="aura-kicker">{{ kicker | escape }}</span>{% endif %}
    <h1 class="aura-title">{{ heading | escape }}</h1>
    {% if subheading %}<p class="aura-sub">{{ subheading | escape }}</p>{% endif %}
    {% if cta_label %}<a class="btn aura-cta" href="{{ cta_href | default: '/collections/all' | escape }}">{{ cta_label | escape }}</a>{% endif %}
  </div>
</section>
`;

const DUO = `<section class="rt duo">
  <a class="duo-panel" href="{{ a_href | default: '/collections/all' | escape }}"><span>{{ a_label | default: 'The ritual' | escape }}</span></a>
  <a class="duo-panel" href="{{ b_href | default: '/collections/all' | escape }}"><span>{{ b_label | default: 'Bestsellers' | escape }}</span></a>
</section>
`;

const AURA_CSS = `
/* Aura base sections */
.aura-hero{background:var(--surface);padding:100px 0;text-align:center}
.aura-hero-in{max-width:680px;margin:0 auto}
.aura-kicker{display:inline-block;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin-bottom:18px}
.aura-title{font-size:clamp(2.6rem,6vw,4.4rem);line-height:1.03;letter-spacing:-.01em;margin:0 0 18px;text-wrap:balance}
.aura-sub{font-size:1.18rem;color:var(--muted);max-width:52ch;margin:0 auto 30px}
.aura-cta{border-radius:999px;padding:13px 28px}
.duo{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:16px 20px 44px}
.duo-panel{aspect-ratio:1;display:flex;align-items:flex-end;padding:22px;background:var(--surface);border-radius:calc(var(--radius) + 6px);font-family:var(--font-heading);font-size:1.5rem;transition:filter .15s}
.duo-panel:hover{filter:brightness(.98)}
@media (max-width:720px){.duo{grid-template-columns:1fr}.aura-hero{padding:72px 0}}
`;

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export function auraBundleTheme(): ThemeFiles {
  const base = defaultBundleTheme();
  return {
    ...base,
    'config/tokens.json': json(TOKENS),
    'templates/index.json': json(INDEX),
    'sections/aura-hero.liquid': AURA_HERO,
    'sections/duo.liquid': DUO,
    'assets/base.css': `${base['assets/base.css']}\n${AURA_CSS}`,
  };
}
