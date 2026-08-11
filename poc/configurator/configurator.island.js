// OFCE-491 / R2 tail · the HARDEST island: a multi-step product configurator with DEPENDENT
// validation — the case research flagged as where HTMX/Alpine might break and a framework earns its
// bytes. The test: can Alpine express it, or do we need Preact?
//
// Dependencies modelled: colors depend on model; sizes depend on model+color; some size/colour
// combos are out of stock (blocked); each step is gated on the previous being valid; the price is
// derived from all three selections. This is ALL the custom JS the island ships.

const CATALOG = {
  models: [
    { id: 'air', name: 'Air', base: 4999 },
    { id: 'pro', name: 'Pro', base: 8999 },
  ],
  colors: {
    air: [
      { id: 'black', name: 'Black', add: 0 },
      { id: 'blue', name: 'Blue', add: 300 },
    ],
    pro: [
      { id: 'black', name: 'Black', add: 0 },
      { id: 'silver', name: 'Silver', add: 500 },
      { id: 'gold', name: 'Gold', add: 900 },
    ],
  },
  // key = `${model}:${color}` → available sizes with per-size surcharge + stock
  sizes: {
    'air:black': [
      { id: 's', name: 'S', add: 0, stock: true },
      { id: 'm', name: 'M', add: 0, stock: true },
      { id: 'l', name: 'L', add: 0, stock: false },
    ],
    'air:blue': [
      { id: 's', name: 'S', add: 0, stock: true },
      { id: 'm', name: 'M', add: 0, stock: false },
    ],
    'pro:black': [
      { id: 'm', name: 'M', add: 0, stock: true },
      { id: 'l', name: 'L', add: 200, stock: true },
    ],
    'pro:silver': [
      { id: 'm', name: 'M', add: 0, stock: true },
      { id: 'l', name: 'L', add: 200, stock: true },
    ],
    'pro:gold': [{ id: 'l', name: 'L', add: 200, stock: true }],
  },
};

document.addEventListener('alpine:init', () => {
  Alpine.data('configurator', () => ({
    catalog: CATALOG,
    step: 1,
    model: null,
    color: null,
    size: null,
    adding: false,
    added: false,

    // DEPENDENT options — pure derived state, recomputed reactively when an upstream pick changes.
    get colors() {
      return this.model ? CATALOG.colors[this.model] : [];
    },
    get sizes() {
      return this.model && this.color ? (CATALOG.sizes[`${this.model}:${this.color}`] ?? []) : [];
    },
    get price() {
      if (!this.model) return 0;
      const m = CATALOG.models.find((x) => x.id === this.model);
      const c = this.colors.find((x) => x.id === this.color);
      const s = this.sizes.find((x) => x.id === this.size);
      return (m?.base ?? 0) + (c?.add ?? 0) + (s?.add ?? 0);
    },

    // Picking upstream RESETS downstream (a Pro colour may not exist on Air, etc.).
    pickModel(id) {
      this.model = id;
      this.color = null;
      this.size = null;
    },
    pickColor(id) {
      this.color = id;
      this.size = null;
    },
    // out-of-stock is blocked — dependent validation, not just display.
    pickSize(id) {
      const s = this.sizes.find((x) => x.id === id);
      if (s && s.stock) this.size = id;
    },

    // Step gating: each step needs its own field before Next unlocks.
    get canNext() {
      return (
        (this.step === 1 && !!this.model) ||
        (this.step === 2 && !!this.color) ||
        (this.step === 3 && !!this.size)
      );
    },
    get complete() {
      return !!(this.model && this.color && this.size);
    },
    next() {
      if (this.canNext && this.step < 4) this.step++;
    },
    back() {
      if (this.step > 1) this.step--;
    },

    async addToCart() {
      if (!this.complete) return;
      this.adding = true;
      try {
        const r = await fetch('/cart/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, color: this.color, size: this.size }),
        });
        this.added = r.ok;
      } catch {
        this.added = false;
      } finally {
        this.adding = false;
      }
    },
  }));
});
