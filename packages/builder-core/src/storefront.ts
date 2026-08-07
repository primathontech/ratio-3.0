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
  --accent:#2563eb;--accent-ink:#fff;--ink:#0f172a;--muted:#475569;--bg:#fff;
  --surface:#f1f5f9;--border:#e2e8f0;--radius:14px;--maxw:1120px;--base:16px;
  --font:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --font-heading:var(--font);
}
html{-webkit-text-size-adjust:100%;font-size:var(--base)}
body{margin:0;font-family:var(--font);color:var(--ink);background:var(--bg);line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{font-family:var(--font-heading)}
img{max-width:100%;display:block}
a{color:inherit;text-decoration:none}
.rt{max-width:var(--maxw);margin:0 auto;padding:0 20px}
.hdr{border-bottom:1px solid var(--border);background:var(--bg);position:sticky;top:0;z-index:20}
.hdr-in{display:flex;align-items:center;gap:26px;height:64px}
.hdr-brand{font-weight:800;font-size:1.2rem;font-family:var(--font-heading);letter-spacing:-.02em;white-space:nowrap}
.hdr-nav{display:flex;align-items:center;gap:24px;height:100%}
.hdr-item{position:relative;display:inline-flex;align-items:center;height:100%}
.hdr-link{display:inline-flex;align-items:center;height:100%;font-size:.95rem;font-weight:700;white-space:nowrap;text-underline-offset:7px;text-decoration-thickness:2px}
.hdr-item:hover>.hdr-link,.hdr-item:focus-within>.hdr-link{text-decoration:underline}
.hdr-caret::after{content:'';display:inline-block;width:.38em;height:.38em;margin-left:.42em;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-.14em) rotate(45deg);opacity:.6;transition:transform .18s,opacity .18s}
.hdr-item:hover .hdr-caret::after,.hdr-item:focus-within .hdr-caret::after{transform:translateY(.04em) rotate(-135deg);opacity:1}
.hdr-drop{position:absolute;top:100%;left:0;display:none;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 16px 40px rgba(24,24,27,.14);padding:14px 8px;min-width:264px;z-index:30}
.hdr-item:hover>.hdr-drop,.hdr-item:focus-within>.hdr-drop{display:block}
.hdr-drop ul{list-style:none;margin:0;padding:0}
.hdr-drop-link{display:block;padding:9px 18px;font-size:.95rem;color:var(--ink);white-space:nowrap;border-radius:8px}
.hdr-drop-link:hover{color:var(--accent);background:var(--surface)}
.hdr-acc{border:0}
.hdr-acc-h{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:11px 18px;font-size:.97rem;font-weight:600;color:var(--ink);cursor:pointer;white-space:nowrap;list-style:none}
.hdr-acc-h::-webkit-details-marker{display:none}
.hdr-acc-h::after{content:'';flex:none;width:.42em;height:.42em;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-.1em) rotate(45deg);transition:transform .18s;opacity:.55}
.hdr-acc[open]>.hdr-acc-h{color:var(--accent)}
.hdr-acc[open]>.hdr-acc-h::after{transform:translateY(.05em) rotate(-135deg);opacity:1}
.hdr-acc-solo::after{display:none}
.hdr-acc-list{margin:0 0 6px 22px;padding:0;border-left:2px solid var(--border)}
.hdr-actions{margin-left:auto;display:flex;align-items:center;gap:18px}
.hdr-search{display:flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:10px;padding:9px 14px;min-width:230px;color:var(--muted)}
.hdr-search input{border:0;outline:0;background:transparent;font:inherit;font-size:.92rem;color:var(--ink);width:100%}
.hdr-search input::placeholder{color:var(--muted)}
.hdr-action{display:inline-flex;align-items:center;gap:7px;position:relative;font-size:.92rem;font-weight:600;white-space:nowrap}
.hdr-action:hover{color:var(--accent)}
.hdr-ic{width:22px;height:22px;flex:none}
.hdr-badge{position:absolute;top:-7px;left:12px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#e11d48;color:#fff;font-size:.66rem;font-weight:700;display:flex;align-items:center;justify-content:center;line-height:1}
.hdr-acct{position:relative;display:inline-flex}
.hdr-acct-btn{background:none;border:0;cursor:pointer;color:inherit;font:inherit}
.hdr-acct-menu{position:absolute;right:0;top:calc(100% + 10px);min-width:180px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 10px 28px rgba(24,24,27,.12);padding:8px;display:flex;flex-direction:column;gap:2px;z-index:50}
.hdr-acct-menu[hidden]{display:none}
.hdr-acct-menu a,.hdr-acct-menu button{display:block;width:100%;text-align:left;padding:9px 12px;border-radius:8px;background:none;border:0;cursor:pointer;color:inherit;font:inherit;font-size:.92rem}
.hdr-acct-menu a:hover,.hdr-acct-menu button:hover{background:var(--surface);color:var(--accent)}
.hdr-acct-menu #rt-logout{margin-top:4px;border-top:1px solid var(--border);border-radius:0}
@media (max-width:900px){.hdr-search{min-width:0;width:150px}}
@media (max-width:760px){.hdr-nav,.hdr-action-t{display:none}}
.hero{padding:76px 0 64px;text-align:center}
.hero h1{font-size:clamp(2rem,5vw,3.25rem);line-height:1.05;letter-spacing:-.02em;margin:0 0 14px;text-wrap:balance}
.hero p{font-size:1.15rem;color:var(--muted);margin:0 auto 26px;max-width:52ch}
.btn,.button{display:inline-block;background:var(--accent);color:var(--accent-ink);font-weight:600;padding:12px 22px;border-radius:calc(var(--radius) - 4px);transition:filter .15s}
.btn:hover,.button:hover{filter:brightness(1.08)}
.heading{font-size:1.5rem;letter-spacing:-.01em;margin:44px 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:20px;padding:6px 0 40px}
.card{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--bg);transition:box-shadow .16s,transform .16s;display:flex;flex-direction:column}
.card:hover{box-shadow:0 10px 28px rgba(24,24,27,.09);transform:translateY(-2px)}
.card-link{display:flex;flex-direction:column;flex:1}
.card .ph{aspect-ratio:1;background:var(--surface)}
.card .ph img{width:100%;height:100%;object-fit:cover}
.card .body{padding:12px 14px;font-size:.95rem}
.card .price{color:var(--accent);font-weight:700;margin-top:4px}
.card-atc{padding:0 14px 14px}
.card-atc .btn{width:100%;padding:9px 14px;font-size:.9rem}
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
.atc{margin:18px 0 0}
.atc-btn{width:100%;max-width:320px;font-size:1rem;padding:13px 22px}
.cart-main{padding:40px 20px 72px;max-width:820px}
.cart-title{font-size:1.9rem;letter-spacing:-.02em;margin:0 0 24px}
.cart-lines{display:flex;flex-direction:column;gap:4px}
.cart-line{display:grid;grid-template-columns:64px 1fr auto auto;align-items:center;gap:16px;padding:16px 0;border-bottom:1px solid var(--border)}
.cart-qty{display:flex;align-items:center;gap:2px;border:1px solid var(--border);border-radius:9px;padding:2px}
.cart-qty form{display:flex}
.cart-qty button{width:30px;height:30px;border:0;background:transparent;color:var(--ink);font-size:1.05rem;line-height:1;cursor:pointer;border-radius:7px}
.cart-qty button:hover:not(:disabled){background:var(--surface);color:var(--accent)}
.cart-qty button:disabled{color:var(--muted);opacity:.45;cursor:default}
.cart-qty-n{min-width:26px;text-align:center;font-weight:600;font-variant-numeric:tabular-nums}
.cart-line-ph{width:64px;height:64px;border-radius:calc(var(--radius) - 4px);background:var(--surface);overflow:hidden}
.cart-line-ph img{width:100%;height:100%;object-fit:cover}
.cart-line-t{font-weight:600}
.cart-line-q{color:var(--muted);font-size:.9rem;margin-top:2px}
.cart-line-sum{font-weight:700;font-variant-numeric:tabular-nums}
.cart-foot{margin-top:26px;display:flex;flex-direction:column;align-items:flex-end;gap:16px}
.cart-sub{display:flex;justify-content:space-between;gap:40px;width:100%;max-width:340px;font-size:1.15rem;font-weight:700;font-variant-numeric:tabular-nums}
.cart-checkout{width:100%;max-width:340px;text-align:center;font-size:1.05rem;padding:14px 22px}
.cart-nocheckout{color:var(--muted);font-size:.9rem}
.cart-cont{color:var(--muted);font-size:.95rem}
.cart-cont:hover{color:var(--accent)}
.cart-empty{text-align:center;padding:64px 0;color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:18px}
.order-main{padding:56px 20px 80px;max-width:560px;display:flex;justify-content:center}
.order-card{width:100%;text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px}
.order-title{font-size:2rem;letter-spacing:-.02em;margin:0}
.order-sub{color:var(--muted);margin:0}
.order-rows{width:100%;max-width:360px;margin:10px 0 18px;display:flex;flex-direction:column;gap:10px}
.order-row{display:flex;justify-content:space-between;gap:24px;padding:12px 16px;border:1px solid var(--border);border-radius:var(--radius);font-variant-numeric:tabular-nums}
.order-row span:first-child{color:var(--muted)}
.acct-main{padding:40px 20px 72px;max-width:820px}
.acct-login{display:flex;flex-direction:column;align-items:flex-start;gap:16px;color:var(--muted)}
.acct-orders{display:flex;flex-direction:column;gap:18px}
.acct-order{border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px}
.acct-order-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.acct-order-id{font-weight:700}
.acct-order-status{font-size:.82rem;color:var(--muted);text-transform:capitalize}
.acct-order-total{font-weight:700;border-top:1px solid var(--border);padding-top:10px;margin-top:4px}
.acct-empty{color:var(--muted)}
.acct-logout{margin-top:24px;background:none;border:0;cursor:pointer}
`;

// The full <style> block to drop into <head>: safe token overrides first, then the base rules.
export function storefrontHead(tokens: ThemeTokens = {}): string {
  return `<style>${rootVars(tokens)}${BASE}</style>`;
}
