# Page builder, end to end

How a page gets built and served — from the shopper's click to the finished HTML —
including the layout, the live product data, the theme, and how the cache stays fresh.
Written in plain language.

## The one-line idea

A shop owner **builds** a page once (blocks + a chosen collection + colours). Later,
when a shopper opens that page, the system **puts it together fresh** from three things
— the layout, the live products, and the look — and serves it fast.

There are two sides. Think of a **kitchen** (where the recipe and cooking happen) and a
**counter** (where the customer is served fast).

## 1. The whole system — who talks to whom

```
   SHOP OWNER (admin)                         SHOPPER (public)
        │                                          │
        │ builds & configures                      │ opens a page
        ▼                                          ▼
  ┌─────────────┐                          ┌──────────────┐
  │  Admin app  │                          │  Cloudflare  │  ← the "counter"
  │  (browser)  │                          │     EDGE     │    (fast, near user)
  └──────┬──────┘                          └──────┬───────┘
         │ save                                   │ if page not ready here,
         ▼                                        ▼ ask the kitchen
  ┌─────────────┐                          ┌──────────────┐
  │  admin-api  │                          │    ORIGIN    │  ← the "kitchen"
  │             │                          │ (the one and │    (puts the page
  └──────┬──────┘                          │ only cook)   │     together)
         │                                 └──────┬───────┘
         │  writes                                │ reads
         ▼                                        ▼
  ┌──────────────────────── POSTGRES (the store's records) ─────────────────────┐
  │  who the store is  •  its colours (theme)  •  its pages (layout + choices)   │
  └──────────────────────────────────────────────────────────────────────────────┘
                                        ▲
                                        │ products come from OUTSIDE
                              ┌──────────────────────┐
                              │  gokwik data backend  │  ← the product warehouse
                              │  (via @shopkit)       │    (NOT ours)
                              └──────────────────────┘
```

Key point: **we own the layout and the look. We do not own the products.** Products
live in a separate warehouse (gokwik). We only fetch them when needed.

## 2. The shop owner's side — building the page

The owner does three separate things, and each is saved on its own:

```
  1. Make the store        →  POST /stores (with a gokwik merchantId)
                              "this store's products come from warehouse X"

  2. Set the look          →  Theme settings panel
                              brand colour + font + size + roundness + width
                              (all picked from safe choices, can't break)

  3. Build the page        →  Page builder
                              add blocks (hero, product grid, text…)
                              pick a collection from a dropdown
                              → Save draft → Publish
```

Important: when the owner picks a collection, we **do not** copy the products into the
page. We only save a **note**: _"this grid should show collection `mrp-699`."_ The real
products are fetched later, fresh. (This is why prices in the saved page are never stale.)

## 3. The shopper's side — one request, step by step

A shopper opens `/collections/mrp-699`:

```
  SHOPPER opens /collections/mrp-699
        │
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │ COUNTER (Cloudflare edge)                                  │
  │  Is this exact page already made and still fresh?          │
  │      YES ──────────────▶ hand it over instantly.  DONE.    │
  │      NO  ──────────────▶ ask the kitchen…                  │
  └───────────────────────────────┬────────────────────────────┘
                                   ▼
  ┌──────────────────────────────────────────────────────────┐
  │ KITCHEN (origin) — puts the page together                  │
  │                                                            │
  │  a) Which page is this?   → "a collection page, handle =    │
  │                              mrp-699"   (the router)        │
  │                                                            │
  │  b) Whose store?          → read the store's THEME +        │
  │                              its warehouse id (Postgres)    │
  │                                                            │
  │  c) Get the layout        → the published page (blocks +    │
  │                              the saved note "show mrp-699") │
  │                                                            │
  │  d) Fetch the products    → go to the gokwik warehouse,     │
  │                              ask for collection mrp-699,     │
  │                              get products back AS-IS         │
  │                              (raw numbers, no changes)       │
  │                                                            │
  │  e) Assemble the HTML     → fill the blocks with products,  │
  │                              apply the theme colours/fonts,  │
  │                              turn paise into ₹ right here     │
  │                                                            │
  │  f) Tag the page          → stick invisible labels on it:   │
  │                              "collection:mrp-699",           │
  │                              "product:123…", "this store"    │
  └───────────────────────────────┬────────────────────────────┘
                                   ▼
        Counter keeps a copy (with its labels) and serves the shopper.
        Next shopper for the same page → instant, straight from the counter.
```

One rule from steps (d)/(e): **we never change the data in the middle.** The warehouse
gives raw numbers (like price in paise), we carry them untouched, and we only shape them
(₹, image choice, sale strike-through) at the very last moment when writing the HTML.

## 4. The three ingredients (the heart of it)

Every page is made from three things that meet only for that one moment of cooking,
then go their separate ways:

```
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │  1. LAYOUT   │   │  2. DATA     │   │  3. LOOK     │
        │  (template)  │   │  (products)  │   │  (theme)     │
        ├──────────────┤   ├──────────────┤   ├──────────────┤
        │ OURS         │   │ gokwik       │   │ OURS         │
        │ page builder │   │ warehouse    │   │ theme knobs  │
        │ blocks +     │   │ live, fresh  │   │ colour/font/ │
        │ "show mrp-699"│  │ every render │   │ size/width   │
        └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
               └──────────────────┼──────────────────┘
                                  ▼
                        cook once → one HTML page
```

Because they are separate, each can change on its own:

- owner edits the layout → only that page changes
- warehouse changes a price → only pages showing that product change
- owner changes the colour → all the store's pages change

## 5. Keeping it fresh — the "throw away the old copy" step

The counter keeps copies to be fast. So when something changes, we must tell the counter
_"your copy is old, throw it away."_ That is done by the invisible **labels** from step (f):

```
  WHAT CHANGED           WHO TELLS THE COUNTER         WHICH COPIES ARE TOSSED
  ────────────           ─────────────────────         ───────────────────────
  price / product        gokwik → our webhook          pages with that product
                                                        (label prod:123)   *
  owner publishes page    publish button                that page's copies   ✅
  owner changes theme     theme save                    all the store's pages ✅

  ✅ = wired to the real Cloudflare counter (purge by URL)
  *  = still to do: needs a "which pages show product 123?" index
       (or Cloudflare Enterprise cache-tags). Local dev already does this by tag.
```

Note: in local development, the "toss the old copy" message works by label (the dev
edge simulator understands labels). The deployed Cloudflare edge does not purge by label
on non-Enterprise plans, so publish and theme purge **by URL** instead, and the purge
result is reported back (so a failed purge is visible, never silent).

## The whole thing in one breath

> A shopper asks for a page → the **counter** serves it instantly if it has a fresh copy
> → otherwise the **kitchen** figures out which page it is, reads the store's **look**,
> gets the **layout**, fetches **live products** from the warehouse, cooks one HTML page
> (shaping numbers only at the end), labels it, and the counter keeps that labelled copy
> to serve everyone else fast. When anything changes, the matching labels tell the
> counter to toss the old copy.

## Where this lives in the code

| Step                              | Code                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| Router (which page is this)       | `packages/page-builder/core/router.ts`                               |
| Read store theme + warehouse id   | `packages/data/repo` (`getTenant`)                                   |
| Get the published layout          | `packages/page-builder/core/store*.ts` (`getLive`)                   |
| Fetch products (no changes)       | `packages/page-builder/core/resolve*.ts` + `@shopkit/data-layer`     |
| Assemble HTML + theme             | `packages/page-builder/core/compose.ts` + `storefront.ts`, `render/` |
| Serve + cache at the edge         | `services/edge-cloudflare/worker.ts`, `packages/edge/core`           |
| Purge (publish / theme / webhook) | `services/admin-api/app.ts`                                          |
