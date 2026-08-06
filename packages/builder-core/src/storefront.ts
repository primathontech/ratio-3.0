// Storefront theme layer (Slice 3). composePage injects this <style> into the page <head> so the
// first-party section classes render as a real storefront. Brand tokens (accent colour, corner
// radius) come from the tenant's theme and are sanitized before they touch CSS — a merchant value
// can never break out of the `:root` block (the storefront CSP already allows inline <style>).

// Merchant theme = a handful of GLOBAL knobs, every value chosen from a FIXED scale (consistency by
// construction). Only the brand colour is free-form; the rest are keys into the maps below, so a
// merchant can never emit an arbitrary CSS value. Anything off-scale is ignored → base default.
export interface ThemeTokens {
  color?: string; // brand colour — hex only, else ignored
  bodyFont?: string; // key of FONTS
  headingFont?: string; // key of FONTS
  baseSize?: string; // 's' | 'm' | 'l'
  radius?: string; // 'square' | 'soft' | 'rounded'
  container?: string; // 'narrow' | 'normal' | 'wide'
}

// Curated, self-hostable / websafe font stacks (no external CDN — CSP is font-src 'self' data:).
// Indic-capable self-hosted families are a follow-up; the vocabulary is ready for them.
export const FONTS: Record<string, string> = {
  system: `system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`,
  sans: `'Helvetica Neue',Arial,sans-serif`,
  serif: `Georgia,'Times New Roman',serif`,
  rounded: `'Trebuchet MS','Segoe UI',system-ui,sans-serif`,
  mono: `ui-monospace,'SF Mono',Menlo,monospace`,
};
export const BASE_SIZE: Record<string, string> = { s: '15px', m: '16px', l: '18px' };
export const RADIUS: Record<string, string> = { square: '0px', soft: '10px', rounded: '18px' };
export const CONTAINER: Record<string, string> = {
  narrow: '960px',
  normal: '1120px',
  wide: '1200px',
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Auto-derive readable text colour ON the brand fill from its luminance — the merchant picks one
// colour, we guarantee the contrast (no second knob to get wrong).
function onBrandInk(hex: string): string {
  const h = hex.slice(1);
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? '#111827' : '#ffffff';
}

// Only emit overrides that are provably safe — anything else falls back to the base defaults.
function rootVars(t: ThemeTokens): string {
  const vars: string[] = [];
  if (t.color && HEX.test(t.color)) {
    vars.push(`--accent:${t.color}`);
    vars.push(`--accent-ink:${onBrandInk(t.color)}`);
  }
  if (t.bodyFont && FONTS[t.bodyFont]) vars.push(`--font:${FONTS[t.bodyFont]}`);
  if (t.headingFont && FONTS[t.headingFont]) vars.push(`--font-heading:${FONTS[t.headingFont]}`);
  if (t.baseSize && BASE_SIZE[t.baseSize]) vars.push(`--base:${BASE_SIZE[t.baseSize]}`);
  if (t.radius && RADIUS[t.radius]) vars.push(`--radius:${RADIUS[t.radius]}`);
  if (t.container && CONTAINER[t.container]) vars.push(`--maxw:${CONTAINER[t.container]}`);
  return vars.length ? `:root{${vars.join(';')}}` : '';
}

const BASE = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --accent:#4f46e5;--accent-ink:#fff;--ink:#18181b;--muted:#6b7280;--bg:#fff;
  --surface:#f6f6f8;--border:#e7e7ec;--radius:14px;--maxw:1120px;--base:16px;
  --font:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --font-heading:var(--font);
}
html{-webkit-text-size-adjust:100%;font-size:var(--base)}
body{margin:0;font-family:var(--font);color:var(--ink);background:var(--bg);line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{font-family:var(--font-heading)}
img{max-width:100%;display:block}
a{color:inherit;text-decoration:none}
.rt{max-width:var(--maxw);margin:0 auto;padding:0 20px}
.hdr{border-bottom:1px solid var(--border);background:var(--bg);position:sticky;top:0;z-index:10}
.hdr-in{display:flex;align-items:center;gap:28px;height:60px}
.hdr-brand{font-weight:800;font-size:1.15rem;font-family:var(--font-heading);letter-spacing:-.01em}
.hdr-nav{display:flex;align-items:center;gap:22px;height:100%}
.hdr-link{display:inline-flex;align-items:center;height:100%;font-size:.95rem;font-weight:500}
.hdr-link:hover{color:var(--accent)}
.hdr-item{position:relative;display:inline-flex;align-items:center;height:100%}
.hdr-mega{position:absolute;top:100%;left:0;display:none;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 12px 32px rgba(24,24,27,.12);padding:18px 22px}
.hdr-item:hover .hdr-mega,.hdr-item:focus-within .hdr-mega{display:block}
.hdr-cols{display:flex;gap:34px}
.hdr-col{min-width:150px}
.hdr-col-h{display:block;font-weight:700;font-size:.9rem;margin-bottom:8px;white-space:nowrap}
.hdr-col ul{list-style:none;margin:0;padding:0}
.hdr-col li{margin:6px 0}
.hdr-col a{font-size:.9rem;color:var(--muted);white-space:nowrap}
.hdr-col a:hover{color:var(--accent)}
@media (max-width:640px){.hdr-nav{display:none}}
.hero{padding:76px 0 64px;text-align:center}
.hero h1{font-size:clamp(2rem,5vw,3.25rem);line-height:1.05;letter-spacing:-.02em;margin:0 0 14px;text-wrap:balance}
.hero p{font-size:1.15rem;color:var(--muted);margin:0 auto 26px;max-width:52ch}
.btn,.button{display:inline-block;background:var(--accent);color:var(--accent-ink);font-weight:600;padding:12px 22px;border-radius:calc(var(--radius) - 4px);transition:filter .15s}
.btn:hover,.button:hover{filter:brightness(1.08)}
.heading{font-size:1.5rem;letter-spacing:-.01em;margin:44px 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:20px;padding:6px 0 40px}
.card{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--bg);transition:box-shadow .16s,transform .16s}
.card:hover{box-shadow:0 10px 28px rgba(24,24,27,.09);transform:translateY(-2px)}
.card .ph{aspect-ratio:1;background:var(--surface)}
.card .ph img{width:100%;height:100%;object-fit:cover}
.card .body{padding:12px 14px;font-size:.95rem}
.card .price{color:var(--accent);font-weight:700;margin-top:4px}
.price .was{color:var(--muted);font-weight:500;text-decoration:line-through;font-size:.82em;margin-left:8px}
.slideshow{display:flex;gap:16px;overflow-x:auto;padding:6px 0 26px;scroll-snap-type:x mandatory}
.slide{flex:0 0 min(82%,540px);scroll-snap-align:start;background:var(--surface);border-radius:var(--radius);padding:48px 30px;min-height:210px;display:flex;align-items:flex-end}
.slide h2{font-size:1.6rem;margin:0;letter-spacing:-.01em}
.image{margin:26px 0}
.image img{width:100%;border-radius:var(--radius)}
.button{margin:6px 0 34px}
.rich{max-width:68ch;margin:22px auto;color:var(--ink)}
.rich p{margin:0 0 1em}
.rte{color:var(--ink);line-height:1.6}
.rte p{margin:0 0 1em}
.rte a{color:var(--accent);text-decoration:underline}
.pdp{display:grid;grid-template-columns:1fr 1fr;gap:34px;padding:34px 0;align-items:start}
.pdp .ph{aspect-ratio:1;background:var(--surface);border-radius:var(--radius)}
.pdp h1{font-size:2rem;letter-spacing:-.02em;margin:0 0 6px}
.pdp .price{color:var(--accent);font-size:1.4rem;font-weight:700;margin:0 0 14px}
@media (max-width:640px){.pdp{grid-template-columns:1fr}.hero{padding:56px 0 44px}}
.ftr{border-top:1px solid var(--border);background:var(--surface);margin-top:56px}
.ftr-in{padding:40px 20px 32px;display:flex;flex-direction:column;gap:26px}
.ftr-cols{display:flex;flex-wrap:wrap;gap:40px}
.ftr-col{min-width:150px}
.ftr-col-h{display:block;font-weight:700;font-size:.9rem;margin-bottom:10px}
.ftr-col ul{list-style:none;margin:0;padding:0}
.ftr-col li{margin:7px 0}
.ftr-col a{font-size:.9rem;color:var(--muted)}
.ftr-col a:hover{color:var(--accent)}
.ftr-legal{color:var(--muted);font-size:.85rem}
`;

// The full <style> block to drop into <head>: safe token overrides first, then the base rules.
export function storefrontHead(tokens: ThemeTokens = {}): string {
  return `<style>${rootVars(tokens)}${BASE}</style>`;
}
