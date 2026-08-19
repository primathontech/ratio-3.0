import type { ThemeFiles } from './bundle';
import { defaultBundleTheme } from './default-theme';

// A second, structurally-distinct base theme ("Editorial"). Same shared chrome as the Default base
// (header/footer/layout, collection + product pages), but a different feel and a different home: serif
// typography + square corners, a full-width editorial hero, a split image/text feature, and a single
// curated product row — no promo carousel or dual grids. It's authored as the Default base COMPOSED
// with only its distinctive files, so the shared parts aren't duplicated; the composed result is still
// a complete root theme (owns the whole document). Registered in BASE_THEMES as `library-editorial`.

// Serif + square, generous whitespace. Brand colour still comes from the store (tokens carry no color),
// so the merchant's colour applies on top of the editorial typography.
const TOKENS = {
  bodyFont: 'serif',
  headingFont: 'serif',
  baseSize: 'm',
  radius: 'square',
  container: 'normal',
};

// The editorial home. Section types editorial-hero + feature are new (defined below); collection-row +
// brand-story are the shared sections. One handle-independent product row so a fresh store isn't empty.
const INDEX = {
  dataSources: {
    all: { type: 'PRODUCTS', params: { first: 8 } },
  },
  sections: [
    {
      type: 'editorial-hero',
      data: {
        kicker: 'New season',
        heading: 'Made to be lived in',
        subheading:
          'A considered edit of everyday pieces — thoughtfully designed, honestly priced, and built to last.',
        cta_label: 'Shop the collection',
        cta_href: '/collections/all',
      },
    },
    {
      type: 'feature',
      data: {
        kicker: 'The story',
        heading: 'Fewer, better things',
        body: 'We work with makers we trust to produce in small runs, so every piece earns its place. Tell your own story here.',
        cta_label: 'About us',
        cta_href: '/collections/all',
      },
    },
    {
      type: 'collection-row',
      dataSourceKey: 'all',
      data: { heading: 'The edit' },
    },
    { type: 'brand-story' },
  ],
};

const EDITORIAL_HERO = `<section class="ed-hero">
  <div class="rt ed-hero-in">
    {% if kicker %}<span class="ed-kicker">{{ kicker | escape }}</span>{% endif %}
    <h1 class="ed-title">{{ heading | escape }}</h1>
    {% if subheading %}<p class="ed-sub">{{ subheading | escape }}</p>{% endif %}
    {% if cta_label %}<a class="btn" href="{{ cta_href | default: '/collections/all' | escape }}">{{ cta_label | escape }}</a>{% endif %}
  </div>
</section>
`;

const FEATURE = `<section class="rt feat">
  <div class="feat-media">{% if image_url %}<img src="{{ image_url | escape }}" alt="{{ heading | escape }}">{% endif %}</div>
  <div class="feat-body">
    {% if kicker %}<span class="ed-kicker">{{ kicker | escape }}</span>{% endif %}
    <h2>{{ heading | escape }}</h2>
    {% if body %}<p>{{ body | escape }}</p>{% endif %}
    {% if cta_label %}<a class="btn" href="{{ cta_href | default: '/collections/all' | escape }}">{{ cta_label | escape }}</a>{% endif %}
  </div>
</section>
`;

// Styles for the editorial-only sections, appended after the shared base.css (so the shared component
// classes the chrome depends on are still present).
const EDITORIAL_CSS = `
/* Editorial base sections */
.ed-hero{padding:96px 0;border-bottom:1px solid var(--border)}
.ed-hero-in{max-width:760px;margin:0 auto;text-align:center}
.ed-kicker{display:inline-block;font-size:.78rem;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-bottom:18px}
.ed-title{font-size:clamp(2.4rem,6vw,4rem);line-height:1.04;letter-spacing:-.02em;margin:0 0 20px;text-wrap:balance}
.ed-sub{font-size:1.2rem;color:var(--muted);max-width:56ch;margin:0 auto 30px}
.feat{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center;padding:72px 20px}
.feat-media{aspect-ratio:4/5;background:var(--surface);border-radius:var(--radius);overflow:hidden}
.feat-media img{width:100%;height:100%;object-fit:cover}
.feat-body h2{font-size:2rem;letter-spacing:-.01em;margin:0 0 14px}
.feat-body p{font-size:1.08rem;color:var(--muted);margin:0 0 22px;max-width:48ch}
@media (max-width:720px){.feat{grid-template-columns:1fr;gap:26px;padding:48px 20px}.ed-hero{padding:64px 0}}
`;

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export function editorialBundleTheme(): ThemeFiles {
  const base = defaultBundleTheme();
  return {
    ...base,
    'config/tokens.json': json(TOKENS),
    'templates/index.json': json(INDEX),
    'sections/editorial-hero.liquid': EDITORIAL_HERO,
    'sections/feature.liquid': FEATURE,
    'assets/base.css': `${base['assets/base.css']}\n${EDITORIAL_CSS}`,
  };
}
