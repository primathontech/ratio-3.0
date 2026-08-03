// First-party widget library, authored in Liquid (D33 — same engine as merchant code, so merchants
// can read/fork these). Each widget declares the bindings it reads + their tiers; the effective
// cacheability of a page is inferred from the widgets it uses (infer.ts), never hand-declared.
//
// The tiers encode the S1 contract: title/images = static; price/stock = shared-volatile (baked but
// purged on change); cart/personalised = per-user (island, hydrated after the cached shell paints).

import type { Binding } from './infer';

export interface WidgetDef {
  type: string;
  template: string; // Liquid source
  bindings: Binding[]; // what it may read + each binding's tier
}

export const FIRST_PARTY_WIDGETS: Record<string, WidgetDef> = {
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
};
