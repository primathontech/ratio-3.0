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
export interface CartBackend {
  createCart(options?: unknown): Promise<IResponse>;
  getCart(params: { id: string }, options?: unknown): Promise<IResponse>;
  addToCart(params: { id: string; items: CartItemInput[] }, options?: unknown): Promise<IResponse>;
  removeFromCart(params: { id: string; itemIds: string[] }, options?: unknown): Promise<IResponse>;
  updateCart(params: { id: string; items: CartItemInput[] }, options?: unknown): Promise<IResponse>;
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

// ── render: the /cart page (the origin renders this directly, not the page builder) ─────────────
function money(v: number): string {
  return '₹' + v.toFixed(2);
}

// A quantity stepper button: a tiny no-JS form that posts the new quantity for this line.
function qtyBtn(
  variantId: string,
  quantity: number,
  label: string,
  aria: string,
  disabled = false
): string {
  return (
    `<form method="post" action="/cart/update">` +
    `<input type="hidden" name="variantId" value="${esc(variantId)}">` +
    `<input type="hidden" name="quantity" value="${quantity}">` +
    `<button type="submit" aria-label="${aria}"${disabled ? ' disabled' : ''}>${label}</button></form>`
  );
}

// One cart line: image, title, a −/+ quantity stepper (min 1), and the line total. Removing a line
// entirely awaits the gokwik remove contract; for now decrement stops at 1.
function cartLineRow(l: CartLine): string {
  return (
    `<div class="cart-line">` +
    `<div class="cart-line-ph">${l.image ? `<img src="${esc(l.image)}" alt="${esc(l.title)}">` : ''}</div>` +
    `<div class="cart-line-info"><div class="cart-line-t">${esc(l.title)}</div>` +
    `<div class="cart-line-q">${money(l.price)} each</div></div>` +
    `<div class="cart-qty">` +
    qtyBtn(l.id, l.quantity - 1, '−', 'Decrease quantity', l.quantity <= 1) +
    `<span class="cart-qty-n">${l.quantity}</span>` +
    qtyBtn(l.id, l.quantity + 1, '+', 'Increase quantity') +
    `</div>` +
    `<div class="cart-line-sum">${money(l.price * l.quantity)}</div>` +
    `</div>`
  );
}

// A full HTML page for /cart. `styleHead` is storefrontHead(theme); header/footer are the composed
// chrome strings (so the cart page matches the storefront). Checkout hands off to GoKwik.
export function renderCartPage(
  cart: Cart,
  opts: { siteName: string; styleHead: string; header?: string; footer?: string }
): string {
  const { siteName, styleHead, header = '', footer = '' } = opts;
  const inner = cart.items.length
    ? `<div class="cart-lines">${cart.items.map(cartLineRow).join('')}</div>` +
      `<div class="cart-foot"><div class="cart-sub"><span>Subtotal</span><span>${money(cart.subtotal)}</span></div>` +
      (cart.checkoutUrl
        ? `<a class="btn cart-checkout" href="${esc(cart.checkoutUrl)}">Checkout</a>`
        : `<span class="cart-nocheckout">Checkout isn't available yet.</span>`) +
      `<a class="cart-cont" href="/">Continue shopping</a></div>`
    : `<div class="cart-empty"><p>Your cart is empty.</p><a class="btn" href="/">Start shopping</a></div>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Cart · ${esc(siteName)}</title>${styleHead}</head><body>` +
    header +
    `<main class="rt cart-main"><h1 class="cart-title">Your cart</h1>${inner}</main>` +
    footer +
    `</body></html>`
  );
}
