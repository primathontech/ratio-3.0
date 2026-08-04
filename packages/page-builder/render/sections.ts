// First-party section library, authored in Liquid (D33 — same engine as merchant code, so merchants
// can read/fork these). Each section declares the bindings it reads + their tiers; the effective
// cacheability of a page is inferred from the sections it uses (infer.ts), never hand-declared.
//
// The tiers encode the S1 contract: title/images = static; price/stock = shared-volatile (baked but
// purged on change); cart/personalised = per-user (island, hydrated after the cached shell paints).

import type { Binding } from './infer';
import type { SettingDef } from '../registry/settings';

export interface SectionDef {
  type: string;
  template: string; // Liquid source
  bindings: Binding[]; // what it may read + each binding's tier
  kind?: 'section' | 'block'; // default 'section'; blocks are children nested inside a section
  blocks?: string[]; // for sections: the child block types this section accepts
  island?: { name: string };
  settings?: SettingDef[]; // typed editor inputs (Slice 2b)
}

export const FIRST_PARTY_SECTIONS: Record<string, SectionDef> = {
  hero: {
    type: 'hero',
    bindings: [{ name: 'hero', tier: 'static' }],
    settings: [
      { key: 'hero.heading', type: 'text', label: 'Heading' },
      { key: 'hero.sub', type: 'text', label: 'Subheading' },
      { key: 'hero.cta.label', type: 'text', label: 'Button label' },
      { key: 'hero.cta.href', type: 'url', label: 'Button link' },
    ],
    template: `<section class="hero">
  <h1>{{ hero.heading | escape }}</h1>
  {% if hero.sub %}<p>{{ hero.sub | escape }}</p>{% endif %}
  {% if hero.cta %}<a class="btn" href="{{ hero.cta.href | escape }}">{{ hero.cta.label | escape }}</a>{% endif %}
</section>`,
  },

  productGrid: {
    type: 'productGrid',
    bindings: [{ name: 'grid', tier: 'shared-volatile' }], // prices inside → shared-volatile
    settings: [{ key: 'grid.heading', type: 'text', label: 'Section heading' }],
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
    settings: [{ key: 'rich.html', type: 'richtext', label: 'Content' }],
    template: `<section class="rich">{{ rich.html }}</section>`,
  },

  heading: {
    type: 'heading',
    bindings: [{ name: 'heading', tier: 'static' }],
    settings: [{ key: 'heading.text', type: 'text', label: 'Heading' }],
    template: `<h2 class="heading">{{ heading.text | escape }}</h2>`,
  },

  image: {
    type: 'image',
    bindings: [{ name: 'image', tier: 'static' }],
    settings: [
      { key: 'image.src', type: 'image', label: 'Image' },
      { key: 'image.alt', type: 'text', label: 'Alt text' },
    ],
    template: `<figure class="image"><img src="{{ image.src | escape }}" alt="{{ image.alt | escape }}"></figure>`,
  },

  button: {
    type: 'button',
    bindings: [{ name: 'button', tier: 'static' }],
    settings: [
      { key: 'button.label', type: 'text', label: 'Label' },
      { key: 'button.href', type: 'url', label: 'Link' },
    ],
    template: `<a class="button" href="{{ button.href | escape }}">{{ button.label | escape }}</a>`,
  },

  spacer: {
    type: 'spacer',
    bindings: [{ name: 'spacer', tier: 'static' }],
    settings: [{ key: 'spacer.size', type: 'range', min: 0, max: 200, label: 'Height (px)' }],
    template: `<div class="spacer" style="height:{{ spacer.size }}px"></div>`,
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
    settings: [
      { key: 'slide.heading', type: 'text', label: 'Slide heading' },
      { key: 'slide.image', type: 'image', label: 'Slide image' },
    ],
    template: `<div class="slide"><h2>{{ slide.heading | escape }}</h2>{% if slide.image %}<img src="{{ slide.image | escape }}" alt="{{ slide.heading | escape }}">{% endif %}</div>`,
  },
};
