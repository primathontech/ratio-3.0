import type { PageConfig, Section, ProductCard } from '../content-model/index';

// Ratio default theme: turns a PageConfig into a full, styled HTML document, themed by
// the tenant's accent colour. Pure + isomorphic (runs on the Worker and the container).
// This replaces the mocked one-line render.

export interface RenderCtx {
  tenant: { name: string; theme?: { color?: string } | null };
}

export const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function css(accent: string): string {
  return `
:root{--accent:${accent}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5}
a{color:var(--accent);text-decoration:none}
header.site{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid #eee}
header.site .brand{font-weight:700;font-size:20px;color:var(--accent)}
header.site nav a{margin-left:18px;color:#333}
main{max-width:1080px;margin:0 auto;padding:24px}
.hero{padding:56px 24px;text-align:center;background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 10%,#fff),#fff);border-radius:16px;margin-bottom:28px}
.hero h1{font-size:40px;margin:0 0 8px}.hero p{color:#555;margin:0 0 18px}
.btn{display:inline-block;background:var(--accent);color:#fff;padding:12px 20px;border:0;border-radius:10px;font-size:15px;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:18px}
.card{border:1px solid #eee;border-radius:12px;overflow:hidden}
.card .ph{aspect-ratio:1;background:#f3f3f3;display:flex;align-items:center;justify-content:center;color:#bbb}
.card .body{padding:12px}.card .price{font-weight:700;color:var(--accent)}
.pdp{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:start}
.pdp .ph{aspect-ratio:1;background:#f3f3f3;border-radius:12px}
.pdp .price{font-size:24px;font-weight:700;color:var(--accent);margin:8px 0 18px}
footer.site{padding:28px 24px;color:#888;border-top:1px solid #eee;margin-top:40px;text-align:center;font-size:14px}
@media(max-width:640px){.pdp{grid-template-columns:1fr}}
`.trim();
}

function productCard(p: ProductCard): string {
  return `<a class="card" href="${esc(p.href)}"><div class="ph">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" style="width:100%">` : 'image'}</div><div class="body"><div>${esc(p.title)}</div><div class="price">${esc(p.price)}</div></div></a>`;
}

function renderSection(s: Section): string {
  switch (s.kind) {
    case 'hero':
      return `<section class="hero"><h1>${esc(s.heading)}</h1>${s.sub ? `<p>${esc(s.sub)}</p>` : ''}${s.cta ? `<a class="btn" href="${esc(s.cta.href)}">${esc(s.cta.label)}</a>` : ''}</section>`;
    case 'richText':
      return `<section class="rich">${s.html ?? ''}</section>`; // authored HTML
    case 'productGrid':
      return `<section>${s.heading ? `<h2>${esc(s.heading)}</h2>` : ''}<div class="grid">${(s.products ?? []).map(productCard).join('')}</div></section>`;
    case 'product':
      return `<section class="pdp"><div class="ph"></div><div><h1>${esc(s.title)}</h1><div class="price">${esc(s.price)}</div>${s.description ? `<p>${esc(s.description)}</p>` : ''}<button class="btn atc">Add to cart</button></div></section>`;
    default:
      return '';
  }
}

// Only a hex colour may reach the <style> block. Anything else (e.g. a stored
// "#000}</style><script>…") falls back to the default, so the accent can never break out
// of the stylesheet — the last line of defence behind boundary validation.
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export function renderPage(page: PageConfig, ctx: RenderCtx): string {
  const raw = ctx.tenant.theme?.color;
  const accent = raw && HEX_COLOR.test(raw) ? raw : '#111111';
  const name = esc(ctx.tenant.name);
  const main = page.sections.map(renderSection).join('\n');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(page.title ?? ctx.tenant.name)}</title><style>${css(accent)}</style></head><body>` +
    `<header class="site"><a class="brand" href="/">${name}</a><nav><a href="/">Home</a><a href="/cart">Cart</a></nav></header>` +
    `<main>${main}</main>` +
    `<footer class="site">© ${name} · powered by Ratio</footer>` +
    `</body></html>`
  );
}
