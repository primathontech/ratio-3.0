// Section registry (Track 5) — the platform's single catalogue of renderable sections: first-party
// (trusted) and merchant/app custom (untrusted, REQ-1). Registration is the ENFORCEMENT POINT for
// the platform's hard gate: no request-time arbitrary code in the render path, per-user content =
// islands only. A section that fails inference, uses a non-allowlisted filter, or lands on the
// per-user tier without being an island is rejected AT REGISTRATION — mechanically, not by
// review (REQ-3).
//
// Versions are immutable (deep-frozen): re-registering a type appends a new version, it never
// mutates the old one. Pages pin the version they were built with, so a section update can't
// silently change already-published pages (they re-render on their own edit→purge cycle).

import {
  compile,
  render,
  UNTRUSTED_LIMITS,
  FILTER_ALLOWLIST,
} from '@ratio/page-builder-render/engine';
import { renderUntrusted } from '@ratio/page-builder-render/isolate';
import { inferTier, type Binding, type Tier } from '@ratio/page-builder-render/infer';
import { FIRST_PARTY_SECTIONS } from '@ratio/page-builder-render/sections';
import type { SettingDef } from './settings';

// ── the platform-owned binding catalog ───────────────────────────────────────
// Binding identity → tier (+ html flag for sanitize-at-save). This is THE source of tier truth:
// author-supplied tiers are IGNORED (review blocker #5 — an untrusted author could otherwise
// declare `user` as 'static' and bake per-user bytes into the shared shell). Names NOT in the
// catalog are section CONFIG: their data arrives exclusively from the saved PageDoc (static by
// construction — validated at save, never from request context), so they are forced 'static'.
export interface CatalogEntry {
  tier: Tier;
  html?: boolean; // value carries authored HTML → sanitized at save (theme safeRichText)
}

export const BINDING_CATALOG: Record<string, CatalogEntry> = {
  // platform data sources
  product: { tier: 'shared-volatile' }, // the canonical product carries its (volatile) price
  collection: { tier: 'static' },
  price: { tier: 'shared-volatile' },
  stock: { tier: 'shared-volatile' },
  grid: { tier: 'shared-volatile' }, // product lists carry prices
  segment: { tier: 'per-segment' },
  // request-context sources — these are what blocker #5 protects; never claimable as config
  user: { tier: 'per-user' },
  customer: { tier: 'per-user' },
  cart: { tier: 'per-user' },
  session: { tier: 'per-user' },
  // authored-content bindings
  hero: { tier: 'static' },
  rich: { tier: 'static', html: true },
};

// Resolve the EFFECTIVE bindings for a template: catalog names get the catalog tier, unknown
// names are merchant config (static). The author's declared tier is discarded on purpose.
export function effectiveBindings(declared: Binding[]): Binding[] {
  return declared.map((b) => ({ name: b.name, tier: BINDING_CATALOG[b.name]?.tier ?? 'static' }));
}

export interface SectionInput {
  type: string;
  template: string; // Liquid source
  bindings: Binding[]; // names matter; tiers are overridden by the catalog
  // an island section's TEMPLATE renders only at island-request time (per-user); the shell gets
  // an inert placeholder — per-user content NEVER enters the cached page
  island?: { name: string };
  kind?: 'section' | 'block'; // default 'section'; a block is a child nested inside a section
  blocks?: string[]; // for sections: the child block types this section accepts (Shopify-shaped)
  settings?: SettingDef[]; // typed editor inputs, validated at save (Slice 2b)
}

export interface SectionRecord extends SectionInput {
  version: number;
  trusted: boolean;
  tier: Tier; // INFERRED from template + catalog, never author-declared (REQ-3)
}

export class SectionRejected extends Error {
  constructor(
    public reasons: string[],
    type: string
  ) {
    super(`section '${type}' rejected: ${reasons.join('; ')}`);
  }
}

function deepFreeze<T>(o: T): T {
  Object.freeze(o);
  for (const v of Object.values(o as object))
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return o;
}

export class SectionRegistry {
  // type → versions (index i = version i+1); records are deep-frozen on insert
  private byType = new Map<string, SectionRecord[]>();

  // Register a section. `trusted:false` = merchant/app code (REQ-1): compiled under the sandboxed
  // engine and rendered only via the worker isolate (D40).
  register(input: SectionInput, opts: { trusted: boolean }): SectionRecord {
    // 0. tiers come from the CATALOG, not the author (blocker #5)
    const bindings = effectiveBindings(input.bindings);

    // a block is a leaf: it cannot itself accept child blocks (one level of nesting), and a
    // per-user child is not supported — per-user stays island-only at the section level.
    if (input.kind === 'block' && input.blocks)
      throw new SectionRejected(
        ['a block cannot accept child blocks (one nesting level)'],
        input.type
      );
    if (input.kind === 'block' && input.island)
      throw new SectionRejected(['a block cannot be an island'], input.type);

    // 1. inference gate (REQ-3): undeclared reads / unresolved includes reject regardless of trust —
    //    first-party code obeys the same contract merchants do, that's what makes it forkable.
    //    A section that accepts child blocks may read the reserved `blocks` global (compose injects
    //    the already-composed child HTML there).
    const inf = inferTier(input.template, bindings, input.blocks ? ['blocks'] : []);
    if (!inf.ok) throw new SectionRejected(inf.reasons, input.type);

    // 2. filter allowlist — enforced HERE for EVERY trust level, not left to render time.
    //    LiquidJS strictFilters only errors when the filter EVALUATES, so a banned filter behind
    //    an {% if %} could pass a smoke render and detonate in production. And a trusted section
    //    using an unlisted filter would silently classify as static (the filter contributes no
    //    tier), corrupting inference — so first-party is held to the same allowlist.
    const banned = inf.usedFilters.filter((f) => !(f in FILTER_ALLOWLIST));
    if (banned.length)
      throw new SectionRejected([`non-allowlisted filters: ${banned.join(', ')}`], input.type);

    // 3. the hard gate: per-user tier may ONLY exist behind an island. A shell section whose
    //    template lands on per-user would bake user A's bytes into the shared cache (C2).
    if (inf.tier === 'per-user' && !input.island) {
      throw new SectionRejected(
        [`effective tier is per-user — per-user content must be an island, not shell markup`],
        input.type
      );
    }

    // 4. compile under the target trust level — enforces syntax + parseLimit (oversized source).
    try {
      compile(input.template, { trusted: opts.trusted, limits: UNTRUSTED_LIMITS });
    } catch (e) {
      throw new SectionRejected([`compile failed: ${(e as Error).message}`], input.type);
    }

    const versions = this.byType.get(input.type) ?? [];
    const rec: SectionRecord = deepFreeze({
      ...input,
      bindings,
      version: versions.length + 1,
      trusted: opts.trusted,
      tier: inf.tier,
    });
    versions.push(rec);
    this.byType.set(input.type, versions);
    return rec;
  }

  // latest version, or a pinned one. Absent → undefined (callers decide reject vs fallback).
  get(type: string, version?: number): SectionRecord | undefined {
    const versions = this.byType.get(type);
    if (!versions) return undefined;
    return version == null ? versions[versions.length - 1] : versions[version - 1];
  }

  list(): SectionRecord[] {
    return [...this.byType.values()].map((v) => v[v.length - 1]);
  }
}

// Render one section instance. Trust decides the path: first-party renders in-process (cooperative
// limits suffice for our own code); untrusted goes through the worker isolate with the hard
// wall-clock kill (D40) — one hostile template must never starve reserved-path serving.
export async function renderSection(
  rec: SectionRecord,
  data: Record<string, unknown>
): Promise<string> {
  if (rec.trusted) return render(rec.template, data, { trusted: true });
  return renderUntrusted(rec.template, data);
}

// A registry preloaded with the first-party library (Track 2 sections), trusted, as version 1.
export function defaultRegistry(): SectionRegistry {
  const reg = new SectionRegistry();
  for (const w of Object.values(FIRST_PARTY_SECTIONS)) {
    reg.register(
      {
        type: w.type,
        template: w.template,
        bindings: w.bindings,
        kind: w.kind,
        blocks: w.blocks,
        island: w.island,
        settings: w.settings,
      },
      { trusted: true }
    );
  }
  return reg;
}
