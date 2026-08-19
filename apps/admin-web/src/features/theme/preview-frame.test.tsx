import { describe, test, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewFrame } from './preview-frame';

describe('PreviewFrame', () => {
  test('runs with scripts but isolated (no same-origin) and injects the navigation guard', () => {
    const html = renderToStaticMarkup(
      <PreviewFrame className="x" title="t" html="<!doctype html><html><body>hi</body></html>" />
    );
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin'); // stays in an opaque, isolated origin
    // srcDoc is HTML-escaped, so assert substrings that survive attribute escaping.
    expect(html).toContain('preventDefault'); // links/forms can't navigate the iframe away
    expect(html).toContain('a[href]');
    expect(html).toContain('hi'); // the theme HTML is still there
  });
});
