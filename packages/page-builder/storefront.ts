// Storefront theme layer (Slice 3). composePage injects this <style> into the page <head> so the
// first-party section classes render as a real storefront. Brand tokens (accent colour, corner
// radius) come from the tenant's theme and are sanitized before they touch CSS — a merchant value
// can never break out of the `:root` block (the storefront CSP already allows inline <style>).

export interface ThemeTokens {
  accent?: string; // brand colour — hex only, else ignored
  radius?: number; // corner radius in px, clamped
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Only emit overrides that are provably safe — anything else falls back to the base defaults.
function rootVars(t: ThemeTokens): string {
  const vars: string[] = [];
  if (t.accent && HEX.test(t.accent)) vars.push(`--accent:${t.accent}`);
  if (typeof t.radius === 'number' && Number.isFinite(t.radius))
    vars.push(`--radius:${Math.max(0, Math.min(32, Math.round(t.radius)))}px`);
  return vars.length ? `:root{${vars.join(';')}}` : '';
}

const BASE = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --accent:#4f46e5;--accent-ink:#fff;--ink:#18181b;--muted:#6b7280;--bg:#fff;
  --surface:#f6f6f8;--border:#e7e7ec;--radius:14px;--maxw:1120px;
  --font:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--font);color:var(--ink);background:var(--bg);line-height:1.55;-webkit-font-smoothing:antialiased}
img{max-width:100%;display:block}
a{color:inherit;text-decoration:none}
.rt{max-width:var(--maxw);margin:0 auto;padding:0 20px}
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
.slideshow{display:flex;gap:16px;overflow-x:auto;padding:6px 0 26px;scroll-snap-type:x mandatory}
.slide{flex:0 0 min(82%,540px);scroll-snap-align:start;background:var(--surface);border-radius:var(--radius);padding:48px 30px;min-height:210px;display:flex;align-items:flex-end}
.slide h2{font-size:1.6rem;margin:0;letter-spacing:-.01em}
.image{margin:26px 0}
.image img{width:100%;border-radius:var(--radius)}
.button{margin:6px 0 34px}
.rich{max-width:68ch;margin:22px auto;color:var(--ink)}
.rich p{margin:0 0 1em}
.pdp{display:grid;grid-template-columns:1fr 1fr;gap:34px;padding:34px 0;align-items:start}
.pdp .ph{aspect-ratio:1;background:var(--surface);border-radius:var(--radius)}
.pdp h1{font-size:2rem;letter-spacing:-.02em;margin:0 0 6px}
.pdp .price{color:var(--accent);font-size:1.4rem;font-weight:700;margin:0 0 14px}
@media (max-width:640px){.pdp{grid-template-columns:1fr}.hero{padding:56px 0 44px}}
`;

// The full <style> block to drop into <head>: safe token overrides first, then the base rules.
export function storefrontHead(tokens: ThemeTokens = {}): string {
  return `<style>${rootVars(tokens)}${BASE}</style>`;
}
