// First-party section library, authored in Liquid (D33 — same engine as merchant code, so merchants
// can read/fork these). Each section declares the bindings it reads + their tiers; the effective
// cacheability of a page is inferred from the sections it uses (infer.ts), never hand-declared.
//
// The tiers encode the S1 contract: title/images = static; price/stock = shared-volatile (baked but
// purged on change); cart/personalised = per-user (island, hydrated after the cached shell paints).

import type { Binding } from './infer';

export interface SectionDef {
  type: string;
  template: string; // Liquid source
  bindings: Binding[]; // what it may read + each binding's tier
  kind?: 'section' | 'block'; // default 'section'; blocks are children nested inside a section
  blocks?: string[]; // for sections: the child block types this section accepts
  island?: { name: string };
}

export const FIRST_PARTY_SECTIONS: Record<string, SectionDef> = {
  hero: {
    type: 'hero',
    bindings: [{ name: 'hero', tier: 'static' }],
    template: `<section class="hero">
  <h1>{{ hero.heading | escape }}</h1>
  {% if hero.sub %}<p>{{ hero.sub | escape }}</p>{% endif %}
  {% if hero.cta %}<a class="btn" href="{{ hero.cta.href | escape }}">{{ hero.cta.label | escape }}</a>{% endif %}
</section>`,
  },

  productGrid: {
    type: 'productGrid',
    bindings: [{ name: 'grid', tier: 'shared-volatile' }], // prices inside → shared-volatile
    template: `<section>
  {% if grid.heading %}<h2>{{ grid.heading | escape }}</h2>{% endif %}
  <div class="grid">
    {% for p in grid.products %}
    <a class="card" href="{{ p.href | escape }}">
      <div class="ph">{% if p.image %}<img src="{{ p.image | escape }}" alt="{{ p.title | escape }}">{% endif %}</div>
      <div class="body"><div>{{ p.title | escape }}</div><div class="price">{{ p.price | money }}</div></div>
    </a>
    {% endfor %}
  </div>
</section>`,
  },

  product: {
    type: 'product',
    // title/description = static; price = shared-volatile; the add-to-cart + live stock are an
    // island (per-user), hydrated client-side — NOT rendered into the cached shell here.
    bindings: [
      { name: 'product', tier: 'static' },
      { name: 'price', tier: 'shared-volatile' },
    ],
    template: `<section class="pdp">
  <div class="ph"></div>
  <div>
    <h1>{{ product.title | escape }}</h1>
    <div class="price">{{ price.amount | money }}</div>
    {% if product.description %}<p>{{ product.description | escape }}</p>{% endif %}
    <div data-island="add-to-cart" data-sku="{{ product.sku | escape }}"></div>
  </div>
</section>`,
  },

  richText: {
    type: 'richText',
    bindings: [{ name: 'rich', tier: 'static' }],
    template: `<section class="rich">{{ rich.html }}</section>`,
  },

  // A nested section: it renders no content of its own beyond a wrapper, and injects its child
  // blocks (already composed) where `{{ blocks }}` sits. `blocks` is a reserved global (infer.ts)
  // — the section reads no data bindings itself; its tier is the max of its slides'.
  slideshow: {
    type: 'slideshow',
    kind: 'section',
    blocks: ['slide'],
    bindings: [],
    template: `<section class="slideshow">{{ blocks }}</section>`,
  },

  // A child block — only valid inside a section that accepts 'slide'.
  slide: {
    type: 'slide',
    kind: 'block',
    bindings: [{ name: 'slide', tier: 'static' }],
    template: `<div class="slide"><h2>{{ slide.heading | escape }}</h2>{% if slide.image %}<img src="{{ slide.image | escape }}" alt="{{ slide.heading | escape }}">{% endif %}</div>`,
  },
};
