// Server-side cart for the no-JS storefront (ADR: cart runs at the origin, not the browser). The
// cart itself lives on the commerce backend (gokwik, via @shopkit/data-layer); the origin holds
// only a cart TOKEN in an httpOnly cookie and renders the cart server-side. Add-to-cart is a form
// POST; checkout hands off to the backend's checkoutUrl. (R2 did this client-side with
// @shopkit/cart + the GoKwik side-cart; R3 reuses the same service contract, server-side.)

import type { IResponse } from '@shopkit/data-layer';
import { esc } from './html';

// Canonical cart shapes (mapped from the backend response, which varies by adapter).
export interface CartLine {
  id: string; // line id — used to remove/update the line
  title: string;
  quantity: number;
  price: number; // per-unit, in the store's display currency
  image?: string;
}
export interface Cart {
  id: string; // cart id / token
  items: CartLine[];
  count: number; // total quantity across lines
  subtotal: number;
  checkoutUrl?: string;
}
export interface CartItemInput {
  variantId: string;
  productId?: string;
  quantity: number;
}

export function emptyCart(): Cart {
  return { id: '', items: [], count: 0, subtotal: 0 };
}

// The cart-method subset of @shopkit/data-layer's ICommerceClient (buildCustomClient returns one).
// getProduct is optional — used only to resolve a variant when the caller has just a handle (product
// list/grid data carries no variants, so add-from-grid resolves the variant server-side).
export interface CartBackend {
  createCart(options?: unknown): Promise<IResponse>;
  getCart(params: { id: string }, options?: unknown): Promise<IResponse>;
  addToCart(params: { id: string; items: CartItemInput[] }, options?: unknown): Promise<IResponse>;
  removeFromCart(params: { id: string; itemIds: string[] }, options?: unknown): Promise<IResponse>;
  updateCart(params: { id: string; items: CartItemInput[] }, options?: unknown): Promise<IResponse>;
  getProduct?(params: { handle?: string; id?: string }, options?: unknown): Promise<IResponse>;
  createCheckout?(
    params: { payload: { cart_token: string; checkout_id?: string; attributes?: unknown } },
    options?: unknown
  ): Promise<IResponse>;
}

const num = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const str = (v: unknown): string => (v == null ? '' : String(v));
const amount = (v: unknown): number =>
  v && typeof v === 'object' ? num((v as { amount?: unknown }).amount) : num(v);

// Unwrap a data-layer IResponse to its data, throwing on failure (mirrors R2's DataLayerCartService).
function unwrap(res: IResponse): Record<string, unknown> {
  if (!res || res.success === false) throw new Error(res?.message || 'cart operation failed');
  if (res.data == null) throw new Error('cart data missing');
  return res.data as Record<string, unknown>;
}

// Prices arrive in the currency's MINOR unit (paise for INR); render in major units.
const MINOR = 100;

// Map a backend line + cart to the canonical shape. The gokwik (Shopify-shaped) cart uses the line
// `id` as the mutation key, `final_price`/`price` in paise, and snake_case fields; kept defensive so
// another adapter's shape (camelCase, money as { amount }) still maps.
function mapLine(raw: Record<string, unknown>): CartLine {
  return {
    // `id` is the LINE's removal key — gokwik removeFromCart keys by variant_id, not the numeric
    // line id, so prefer it (fall back to other adapters' line identifiers).
    id: str(raw.variant_id ?? raw.variantId ?? raw.id ?? raw.line_id ?? raw.key),
    title: str(raw.title ?? raw.name ?? raw.product_title),
    quantity: num(raw.quantity ?? 1),
    price: amount(raw.final_price ?? raw.price ?? raw.unit_price) / MINOR,
    image: (raw.image as string) || (raw.image_url as string) || undefined,
  };
}
function toCart(data: Record<string, unknown>): Cart {
  const rawItems = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
  const items = rawItems.map(mapLine);
  const declaredSub = amount(
    data.items_subtotal_price ?? data.subtotal ?? data.totalAmount ?? data.total
  );
  const declaredCount = num(data.item_count);
  return {
    // The cart's durable handle is its token (a UUID); the numeric `id` changes per response.
    id: str(data.token ?? data.id),
    items,
    count: declaredCount || items.reduce((c, l) => c + l.quantity, 0),
    subtotal: declaredSub
      ? declaredSub / MINOR
      : items.reduce((c, l) => c + l.price * l.quantity, 0),
    checkoutUrl: (data.checkoutUrl as string) || (data.checkout_url as string) || undefined,
  };
}

// Thin service over the commerce client's cart methods. Every mutation RETURNS the updated cart (the
// backend echoes it), and the cart's identity is the token it carries — the caller persists that.
export class CartService {
  constructor(private backend: CartBackend) {}

  async get(token: string): Promise<Cart> {
    return toCart(unwrap(await this.backend.getCart({ id: token })));
  }
  // Add items to the token's cart, bootstrapping a fresh cart via createCart when there's no token
  // (the backend keys carts by token, so a cart must exist before addToCart). Returns the updated
  // cart — its `id` is the token to persist in the cookie.
  async add(token: string | null, items: CartItemInput[]): Promise<Cart> {
    let id = token;
    if (!id) {
      const created = unwrap(await this.backend.createCart());
      id = str(created.token ?? created.id);
    }
    return toCart(unwrap(await this.backend.addToCart({ id, items })));
  }
  // Set one line's quantity (min 1). gokwik's updateCart replaces the WHOLE quantity set, so we fetch
  // the current cart and re-send every line with just the target changed (R2's updateItemQuantity).
  // This is the reliable mutation on the gokwik backend.
  async setQuantity(token: string, variantId: string, quantity: number): Promise<Cart> {
    const current = await this.get(token);
    const items = current.items.map((l) => ({
      variantId: l.id,
      quantity: l.id === variantId ? Math.max(1, quantity) : l.quantity,
    }));
    return toCart(unwrap(await this.backend.updateCart({ id: token, items })));
  }

  // Resolve a product's first variant id from its handle. Grid/collection data carries no variants,
  // so add-from-grid posts the handle and the origin resolves the variant here (the same product read
  // the PDP uses). Returns '' when the backend can't look it up — the caller then skips the add rather
  // than sending a bogus id the commerce backend rejects.
  async resolveVariant(handle: string): Promise<string> {
    if (!handle || !this.backend.getProduct) return '';
    try {
      const res = await this.backend.getProduct({ handle });
      if (!res || res.success === false || res.data == null) return '';
      const data = res.data as Record<string, unknown>;
      const product = (data.product ?? data) as Record<string, unknown>;
      const variants = Array.isArray(product.variants)
        ? (product.variants as Record<string, unknown>[])
        : [];
      return variants[0] ? str(variants[0].id ?? variants[0].variant_id) : '';
    } catch {
      return '';
    }
  }

  // Create a GoKwik checkout for the token's cart and return the merchantCheckoutId the browser SDK
  // needs (window.gokwikSdk.initCheckout). The actual payment UI is the SDK's, in the browser — this
  // is only the server-side handshake. Returns '' when the backend can't create one.
  async createCheckout(token: string): Promise<string> {
    if (!token || !this.backend.createCheckout) return '';
    const data = unwrap(
      await this.backend.createCheckout({ payload: { cart_token: token, checkout_id: '' } })
    );
    return str(data.id);
  }

  // Remove lines by variant id — R2's contract (removeFromCart(token, [variantId])). NOTE: on the
  // current gokwik backend this reports success but doesn't persist; wiring a remove button waits on
  // the backend honouring it (tracked for the next slice). Kept here as the documented contract.
  async remove(token: string, variantIds: string[]): Promise<Cart> {
    return toCart(unwrap(await this.backend.removeFromCart({ id: token, itemIds: variantIds })));
  }
}

// ── the cart token cookie: the ONLY client-side cart state on the no-JS storefront ──────────────
const COOKIE_NAME = 'rt_cart';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, matches a cart's life

export function readCartToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim()) || null;
    }
  }
  return null;
}
export function cartCookie(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}
// Expire the cart cookie — the order is placed, the cart is spent, a fresh one starts on the next add.
export function expireCartCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ── render: the /cart page (the origin renders this directly, not the page builder) ─────────────
function money(v: number): string {
  return '₹' + v.toFixed(2);
}

// The order confirmation (thank-you) page, rendered after a GoKwik checkout completes. Full line-item
// detail needs the customer-auth'd order API (deferred); this shows what the order-complete event
// gives us — the order id, total, and payment method.
export interface OrderSummary {
  id: string;
  total?: number; // in the store's display currency
  paymentMethod?: string;
}
export function renderOrderPage(
  order: OrderSummary,
  opts: {
    siteName: string;
    styleHead: string;
    header?: string;
    footer?: string;
    headExtra?: string;
    bodyEnd?: string;
  }
): string {
  const { siteName, styleHead, header = '', footer = '', headExtra = '', bodyEnd = '' } = opts;
  const rows =
    (order.id
      ? `<div class="order-row"><span>Order</span><span>${esc(order.id)}</span></div>`
      : '') +
    (order.total != null
      ? `<div class="order-row"><span>Total</span><span>${money(order.total)}</span></div>`
      : '') +
    (order.paymentMethod
      ? `<div class="order-row"><span>Payment</span><span>${esc(order.paymentMethod)}</span></div>`
      : '');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Order confirmed · ${esc(siteName)}</title>${styleHead}${headExtra}</head><body>` +
    header +
    `<main class="rt order-main"><div class="order-card">` +
    `<h1 class="order-title">Thank you!</h1>` +
    `<p class="order-sub">Your order is confirmed. A confirmation will be sent to you.</p>` +
    (rows ? `<div class="order-rows">${rows}</div>` : '') +
    // Line items are per-order client data (from the checkout event); an integration hydration script
    // fills this from sessionStorage. Empty (and invisible) when there's nothing to show.
    `<div class="order-rows order-items" id="rt-order-items"></div>` +
    `<a class="btn" href="/">Continue shopping</a>` +
    `</div></main>` +
    footer +
    bodyEnd +
    `</body></html>`
  );
}
