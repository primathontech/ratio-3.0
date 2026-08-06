import { STOREFRONT_CSP } from './headers';

// S4 D-R6: the last-resort fallback when even stale content can't be served (origin failed AND no
// cached copy, or routing itself failed). Generated entirely at the edge — no origin/DB needed — so
// it always renders. A 503 + Retry-After (not a raw 500) tells crawlers it's transient; no-store so
// recovery is immediate; generic branding only — we may not know the tenant, and must never show
// another tenant's content or leak internal error detail.
const STORE_UNAVAILABLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Store temporarily unavailable</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#1a1a1a}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.25rem 0;opacity:.8;line-height:1.5}</style></head><body><main><h1>This store is temporarily unavailable</h1><p>We're having a brief problem serving this page. Please try again in a few moments.</p></main></body></html>`;
export function storeUnavailable(): Response {
  return new Response(STORE_UNAVAILABLE_HTML, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'retry-after': '30',
      'cache-control': 'no-store',
      'content-security-policy': STOREFRONT_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}
