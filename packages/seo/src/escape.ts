// Escaping helpers for the three sinks this package writes into: HTML attributes, XML text, and a
// JSON-LD <script> body. Every value that reaches the head/sitemap goes through one of these.

// HTML attribute value (double-quoted).
export function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// XML text node (sitemap <loc>).
export function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Serialize an object into a JSON-LD <script>. The ONLY escaping a <script>-embedded JSON string needs
// is `<` → \u003c: it neutralizes </script> and <!-- without corrupting the JSON (valid inside a string).
export function jsonLdScript(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}
