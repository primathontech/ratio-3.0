// Shared, dependency-free HTML helpers for the page-builder render path: esc (HTML escaping) and
// safeRichText (sanitises authored richText). Pure + isomorphic (runs on the Worker and the
// container). Formerly the standalone @ratio/theme package; folded in here once it was down to
// these two helpers.

export const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Authored richText is untrusted. We fully escape it, then restore ONLY a small allowlist
// of attribute-less formatting tags by literal token replacement. Because escaping runs
// first, an attribute (e.g. onerror=, href=javascript:) can never survive — a tag with any
// attribute simply stays escaped. No parser, no dependency, safe on the Worker and origin.
const RICH_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'b',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'blockquote',
];
export function safeRichText(html: unknown): string {
  let out = esc(html);
  for (const t of RICH_TAGS) {
    out = out.split(`&lt;${t}&gt;`).join(`<${t}>`).split(`&lt;/${t}&gt;`).join(`</${t}>`);
  }
  return out.split('&lt;br/&gt;').join('<br/>').split('&lt;br /&gt;').join('<br/>');
}
