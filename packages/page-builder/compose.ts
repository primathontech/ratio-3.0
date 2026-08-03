// Compose a PageDoc into the cached HTML shell. Sections render in document order; island sections
// contribute ONLY their inert placeholder (their template renders later, per-user, behind the
// /api/island endpoint) — so the shell's effective tier is the max over NON-island sections, and
// by the registration gate that max can never be per-user. The shell is safe shared bytes by
// construction, not by review (C2).

import type { PageDoc } from './doc';
import type { SectionRegistry } from '../section-registry/registry';
import { renderSection } from '../section-registry/registry';
import { islandPlaceholder } from '../section-registry/islands';
import type { Tier } from '../liquid-render/infer';

const ORDER: Tier[] = ['static', 'shared-volatile', 'per-segment', 'per-user'];
const maxTier = (a: Tier, b: Tier): Tier => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ComposedPage {
  html: string;
  tier: Tier; // shell tier — drives the origin's cacheability opt-in (B-2)
  cacheable: boolean;
}

export async function composePage(doc: PageDoc, registry: SectionRegistry): Promise<ComposedPage> {
  let tier: Tier = 'static';
  const parts: string[] = [];

  for (const w of doc.sections) {
    const rec = registry.get(w.type, w.version);
    if (!rec) throw new Error(`section '${w.type}'@${w.version} vanished from registry`); // save pinned it — can't happen without a registry wipe
    if (rec.island) {
      // island: placeholder only. The instance id rides along so the island endpoint can load
      // THIS instance's config. Public bytes only — user identity never appears here.
      parts.push(islandPlaceholder(rec.island.name, { instance: w.id }));
    } else {
      let data = w.data;
      // nested section → compose its child blocks first, inject them where `{{ blocks }}` sits.
      // A block can't be per-user (registration forbids island blocks), so the shell stays safe.
      if (rec.blocks && w.blocks && w.blocks.length) {
        const blockParts: string[] = [];
        for (const b of w.blocks) {
          const brec = registry.get(b.type, b.version);
          if (!brec) throw new Error(`block '${b.type}'@${b.version} vanished from registry`);
          blockParts.push(await renderSection(brec, b.data));
          tier = maxTier(tier, brec.tier);
        }
        data = { ...w.data, blocks: blockParts.join('\n') };
      }
      parts.push(await renderSection(rec, data));
      tier = maxTier(tier, rec.tier);
    }
  }

  // tier is provably below per-user here (registration rejects per-user shell sections), so the
  // shell is always cacheable; the tier still matters upstream (shared-volatile → purge on price
  // change; per-segment → segment key dimension when personalization lands, REQ-2).
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${esc(doc.title ?? '')}</title></head><body>\n` +
    parts.join('\n') +
    `\n<script src="/assets/islands.js" defer></script></body></html>`;

  return { html, tier, cacheable: tier !== 'per-user' };
}
