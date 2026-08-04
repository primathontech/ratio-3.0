// Islands (Track 5) — the ONLY path for per-user content. The cached shell carries inert
// placeholders; a small first-party runtime hydrates them client-side from reserved /api/island/*
// endpoints, which the edge never caches (P8 gate) and which always answer no-store.
//
// The C2 invariant this file owns: the SHELL is byte-identical for every user — personalisation
// happens exclusively after paint, via credentialed fetches. And the B3/CSP invariant: the runtime
// is first-party, served from 'self'; no external origins, no eval, no inline handlers — it works
// under the storefront CSP without loosening it.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// island names are a closed alphabet — they appear in URLs and DOM attributes
const NAME_RE = /^[a-z][a-z0-9-]*$/;

export function assertIslandName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid island name '${name}'`);
}

// The inert placeholder a widget template (or compose step) emits into the shell. Params are
// PUBLIC bytes (sku, list id …) — never user data; they ride the shared cache with the page.
export function islandPlaceholder(name: string, params: Record<string, string> = {}): string {
  assertIslandName(name);
  const qs = new URLSearchParams(params).toString();
  return `<div data-island="${esc(name)}"${qs ? ` data-params="${esc(qs)}"` : ''}></div>`;
}

// Server side of an island: given the request context, produce the per-user HTML fragment.
export type IslandHandler = (ctx: {
  params: URLSearchParams;
  userId: string | null; // from the session cookie — null = anonymous
}) => Promise<{ status?: number; html: string }>;

export class IslandRegistry {
  private handlers = new Map<string, IslandHandler>();

  register(name: string, handler: IslandHandler): void {
    assertIslandName(name);
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  // Serve one island request (origin mounts this under /api/island/:name — a RESERVED path, so
  // the edge gate guarantees it never touches cache). Response is ALWAYS no-store + private:
  // these are the per-user bytes, the exact class C2 forbids in any shared cache.
  async handle(
    name: string,
    params: URLSearchParams,
    userId: string | null
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const headers = {
      'cache-control': 'no-store, private',
      'content-type': 'text/html; charset=utf-8',
    };
    const handler = this.handlers.get(name);
    if (!handler) return { status: 404, headers, body: '' };
    try {
      const res = await handler({ params, userId });
      return { status: res.status ?? 200, headers, body: res.html };
    } catch {
      // an island failure degrades to an empty slot — it must never take the page down
      return { status: 500, headers, body: '' };
    }
  }
}

// The client runtime, served from 'self' (e.g. /assets/islands.js — cacheable, versioned by
// content hash at build). Vanilla, no deps, no eval, no external origins. Injects via
// innerHTML ONLY from same-origin /api/island responses — the server is the trust boundary.
export function islandsRuntimeScript(): string {
  return `(function () {
  'use strict';
  function hydrate(el) {
    var name = el.getAttribute('data-island');
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return;
    var params = el.getAttribute('data-params') || '';
    fetch('/api/island/' + name + (params ? '?' + params : ''), {
      credentials: 'same-origin',
      headers: { accept: 'text/html' }
    })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (html) { if (html) el.innerHTML = html; })
      .catch(function () { /* island failure = empty slot, page stays up */ });
  }
  var els = document.querySelectorAll('[data-island]');
  for (var i = 0; i < els.length; i++) hydrate(els[i]);
})();`;
}
