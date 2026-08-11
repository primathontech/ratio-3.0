// OFCE-491 · Step 2 — streaming render on workerd. Flush the shell immediately, then write each
// section as its (simulated) data resolves, via a TransformStream. `?mode=buffer` renders the old
// way (build the whole string, then respond) so we can compare TTFB with curl -w.
// @ratio/builder-render's barrel is edge-safe since #148 (the untrusted isolate is a separate
// subpath), so these are ordinary package imports now — no reaching into src/.
import { render, FIRST_PARTY_SECTIONS } from '@ratio/builder-render';
import { worstCasePage } from './worst-case';

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmpl = (type: string) => FIRST_PARTY_SECTIONS[type].template;

export default {
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const n = Number(u.searchParams.get('n') ?? 12);
    const products = Number(u.searchParams.get('products') ?? 20);
    const delay = Number(u.searchParams.get('delay') ?? 60); // simulate each section's data fetch
    const mode = u.searchParams.get('mode') ?? 'stream';
    const doc = worstCasePage(n, products);

    if (mode === 'buffer') {
      const parts: string[] = [];
      for (const s of doc.sections) {
        await sleep(delay);
        parts.push(
          await render(tmpl(s.type), s.data as Record<string, unknown>, { trusted: true })
        );
      }
      return new Response(`<!doctype html><html><body>${parts.join('')}</body></html>`, {
        headers: { 'content-type': 'text/html' },
      });
    }

    // stream: the shell leaves the origin before any section has rendered.
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    (async () => {
      await w.write(enc.encode('<!doctype html><html><head><title>stream</title></head><body>'));
      for (const s of doc.sections) {
        await sleep(delay);
        const html = await render(tmpl(s.type), s.data as Record<string, unknown>, {
          trusted: true,
        });
        await w.write(enc.encode(html));
      }
      await w.write(enc.encode('</body></html>'));
      await w.close();
    })();
    return new Response(readable, { headers: { 'content-type': 'text/html' } });
  },
};
