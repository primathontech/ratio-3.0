// OFCE-491 · the hardest island's OWN code — a shoppable hero (hotspot → popover → quick-shop →
// add-to-cart, with an optimistic cart count). The R2 question: does this need a framework, or do
// HTMX + Alpine suffice? Answer below is pure Alpine state + one server POST — no framework.
//
// This is ALL the custom JS the island ships (on top of the htmx+alpine runtime). Its gzipped size
// is the incremental island budget.

document.addEventListener('alpine:init', () => {
  // Shared, cross-island cart state → optimistic count updates instantly; the server POST reconciles.
  Alpine.store('cart', {
    count: 0,
    adding: false,
    async add(variantId) {
      this.adding = true;
      this.count++; // optimistic
      try {
        const r = await fetch('/cart/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ variantId, quantity: 1 }),
        });
        if (!r.ok) throw new Error('add failed');
        const { count } = await r.json();
        if (typeof count === 'number') this.count = count; // reconcile with truth
      } catch {
        this.count--; // roll back the optimistic bump
      } finally {
        this.adding = false;
      }
    },
  });

  Alpine.data('shoppableHero', (hotspots) => ({
    hotspots, // [{ x, y, product: { title, price, variants:[{id,label}] } }]
    openIndex: null,
    variantId: null,
    open(i) {
      this.openIndex = i;
      this.variantId = this.hotspots[i].product.variants[0].id;
    },
    close() {
      this.openIndex = null;
    },
    get active() {
      return this.openIndex === null ? null : this.hotspots[this.openIndex].product;
    },
  }));
});
