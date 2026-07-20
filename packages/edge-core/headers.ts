// Portable edge HTTP + security helpers — no platform binding, so any edge adapter (Cloudflare
// Worker, Akamai EdgeWorkers) can use them to talk to the private origin and to keep responses safe.

// Join origin base + request path without a double slash (ORIGIN_URL may end in "/").
export function originTarget(base: string, path: string, search: string): string {
  return base.replace(/\/+$/, '') + path + search;
}

// Build the fetch init for proxying to the private origin (OFCE-413): forward the request
// body for methods that have one (so reserved /cart, /checkout, /api/* handlers receive it)
// with a safe header allowlist, and inject the trusted x-edge-auth + x-ratio-tenant —
// never forwarding any client-supplied copy of those.
export function proxyInit(
  req: Request,
  tenantId: string,
  edgeSecret: string
): RequestInit & { duplex?: 'half' } {
  const method = req.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const headers = new Headers({ 'x-edge-auth': edgeSecret, 'x-ratio-tenant': tenantId });
  for (const h of ['content-type', 'accept', 'accept-language']) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    body: hasBody ? req.body : undefined,
  };
  if (hasBody) init.duplex = 'half'; // required when streaming a request body
  return init;
}

// Internal headers the origin uses for cache tagging / diagnostics — stripped at the edge so
// they never reach the public (they leak tenant ids + cache-key structure). (M-5)
const INTERNAL_HEADERS = [
  'x-tenant',
  'x-page-type',
  'x-cache',
  'x-surrogate-keys',
  'x-render-count',
  'x-handler',
];
export function publicHeaders(h: Headers): Headers {
  const out = new Headers(h);
  for (const k of INTERNAL_HEADERS) out.delete(k);
  return out;
}

// The ?store= override is a local-dev selector only. It must NOT be honoured on any
// publicly reachable host — including *.workers.dev, which is live in production
// (wrangler workers_dev = true) — or any visitor could render an arbitrary tenant by id
// and poison the 1-year CDN cache. Localhost only.
export function storeOverrideAllowed(host: string): boolean {
  const h = (host || '').split(':')[0].toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost');
}

// Storefront pages carry no first-party JS, so a strict CSP (script-src 'none') is the backstop
// that contains any HTML/color injection that slips through content validation; inline <style> is
// the theme's, so style-src allows it.
export const STOREFRONT_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
