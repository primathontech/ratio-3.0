import { describe, test, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorPreview } from './editor-preview';

const render = (over: Partial<Parameters<typeof EditorPreview>[0]> = {}) =>
  renderToStaticMarkup(
    <EditorPreview
      previewing={false}
      previewErr=""
      previewHtml="<!doctype html><html><body><a href='/products/x'>P</a></body></html>"
      previewPage="index"
      templatePages={['index']}
      onPageChange={() => {}}
      onRefresh={() => {}}
      {...over}
    />
  );

describe('EditorPreview', () => {
  test('sandboxes with scripts but not same-origin, and injects the navigation guard', () => {
    const html = render();
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin'); // stays isolated in an opaque origin
    // The guard that stops a link/button click from navigating the iframe to a blank page.
    // (srcDoc is HTML-escaped, so assert on substrings that survive attribute escaping.)
    expect(html).toContain('preventDefault');
    expect(html).toContain('a[href]');
  });

  test('shows the render error instead of the iframe when preview failed', () => {
    const html = render({ previewErr: 'no template for page' });
    expect(html).toContain('no template for page');
    expect(html).not.toContain('<iframe');
  });
});
