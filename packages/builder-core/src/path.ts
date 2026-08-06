// Path normalization for a PageDoc's route. Kept local to the page-builder so the
// render engine has no dependency on the edge/spine cache-key machinery.
// decodeURI (not decodeURIComponent) keeps %2F encoded — no slash-traversal ambiguity.
export function canonicalPath(rawPath: string): string {
  let p = rawPath.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase()).normalize('NFC');
  try {
    p = decodeURI(p);
  } catch {
    /* leave as-is if malformed */
  }
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}
