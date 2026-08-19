// A live storefront preview is ONE server-rendered page in a sandboxed iframe. Following a link or
// submitting a form would navigate the iframe to a real URL (e.g. /products/…) — which loads the SPA
// with scripts it can't run → a blank page. This guard neutralizes in-preview navigation (anchor clicks
// + form submits) so the preview stays put: it's a design preview, not a click-through storefront.
//
// It runs under sandbox="allow-scripts" WITHOUT allow-same-origin, so the theme's own scripts execute in
// an opaque, isolated origin (no access to the admin, its cookies, or same-origin network) — safe to run.
const PREVIEW_GUARD = `<script>(function(){
  function toEl(n){ while (n && n.nodeType !== 1) n = n.parentNode; return n; }
  document.addEventListener('click', function(e){
    var el = toEl(e.target); var a = el && el.closest ? el.closest('a[href]') : null;
    if (a) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('submit', function(e){ e.preventDefault(); e.stopPropagation(); }, true);
})();</script>`;

// The one place a storefront-preview iframe is rendered — used by every interactive preview (theme code
// editor, base-theme editor, onboarding design step, brand settings) so the sandbox + navigation guard
// stay consistent. (Static thumbnails render their own tiny sandbox="" iframe — no scripts/nav needed.)
export function PreviewFrame({
  html,
  className,
  title,
}: {
  html: string;
  className?: string;
  title?: string;
}) {
  return (
    <iframe
      className={className}
      title={title ?? 'Storefront preview'}
      sandbox="allow-scripts"
      srcDoc={html + PREVIEW_GUARD}
    />
  );
}
