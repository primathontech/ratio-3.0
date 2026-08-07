// Customer order history for the /account page. Auth'd via the customer access token (from the
// KwikPass cookie); the origin passes it to the commerce backend's getOrderHistory. Vendor-neutral:
// maps the backend response to canonical order shapes, same pattern as CartService.
//
// NOTE: the per-order field names below are mapped from the expected getOrderHistory shape
// (data.orders[].order); they are pinned against a live response before this ships (the response
// requires a logged-in customer token, which isn't available offline).
import type { IResponse } from '@shopkit/data-layer';
import { esc } from './html';

export interface OrderLine {
  title: string;
  quantity: number;
  price: number; // per-unit, display currency
}
export interface AccountOrder {
  id: string;
  total?: number;
  status?: string;
  items: OrderLine[];
}

export interface OrderBackend {
  getOrderHistory(
    params: { customerAccessToken: string; page?: number; limit?: number },
    options?: unknown
  ): Promise<IResponse>;
}

const num = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const str = (v: unknown): string => (v == null ? '' : String(v));

function mapOrder(o: Record<string, unknown>): AccountOrder {
  const rawItems = Array.isArray(o.items)
    ? (o.items as Record<string, unknown>[])
    : Array.isArray(o.line_items)
      ? (o.line_items as Record<string, unknown>[])
      : [];
  return {
    id: str(o.orderName ?? o.name ?? o.order_name ?? o.id),
    total: o.total_price != null ? num(o.total_price) : undefined,
    status: (o.financial_status as string) ?? (o.status as string) ?? undefined,
    items: rawItems.map((it) => ({
      title: str(it.title ?? it.name ?? it.product_title),
      quantity: num(it.quantity ?? 1),
      price: num(it.price ?? it.final_price),
    })),
  };
}

export class OrderService {
  constructor(private backend: OrderBackend) {}

  // Returns the customer's orders, or [] when the token is missing/invalid or the backend fails —
  // the caller treats [] as "no orders" and the origin treats a thrown token error as logged-out.
  async history(token: string): Promise<AccountOrder[]> {
    if (!token) return [];
    const res = await this.backend.getOrderHistory({ customerAccessToken: token });
    if (!res || res.success === false || res.data == null) return [];
    const data = res.data as Record<string, unknown>;
    const rows = Array.isArray(data.orders) ? (data.orders as Record<string, unknown>[]) : [];
    return rows.map((r) => mapOrder((r.order ?? r) as Record<string, unknown>));
  }
}

// ── render: the /account page (server-rendered, no-store) ───────────────────────────────────────
function money(v: number): string {
  return '₹' + v.toFixed(2);
}

function orderCard(o: AccountOrder): string {
  const lines = o.items
    .map(
      (l) =>
        `<div class="order-row"><span>${esc(l.title)} × ${l.quantity}</span>` +
        `<span>${money(l.price * l.quantity)}</span></div>`
    )
    .join('');
  return (
    `<div class="acct-order"><div class="acct-order-head">` +
    `<span class="acct-order-id">${esc(o.id)}</span>` +
    (o.status ? `<span class="acct-order-status">${esc(o.status)}</span>` : '') +
    `</div><div class="order-rows">${lines}` +
    (o.total != null
      ? `<div class="order-row acct-order-total"><span>Total</span><span>${money(o.total)}</span></div>`
      : '') +
    `</div></div>`
  );
}

// `loggedIn` drives the two states: the login CTA (button #rt-login, wired by the KwikPass script)
// or the order list + logout (#rt-logout). Chrome + integration fragments come from the origin.
export function renderAccountPage(
  data: { loggedIn: boolean; orders: AccountOrder[] },
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
  const inner = !data.loggedIn
    ? `<div class="acct-login"><p>Log in to see your orders.</p>` +
      `<button type="button" id="rt-login" class="btn">Log in</button></div>`
    : `<div class="acct-orders">` +
      (data.orders.length
        ? data.orders.map(orderCard).join('')
        : `<p class="acct-empty">You have no orders yet.</p>`) +
      `</div><button type="button" id="rt-logout" class="cart-cont acct-logout">Log out</button>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Account · ${esc(siteName)}</title>${styleHead}${headExtra}</head><body>` +
    header +
    `<main class="rt acct-main"><h1 class="cart-title">Your account</h1>${inner}</main>` +
    footer +
    bodyEnd +
    `</body></html>`
  );
}
