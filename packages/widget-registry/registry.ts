// Widget registry (Track 5) — the platform's single catalogue of renderable widgets: first-party
// (trusted) and merchant/app custom (untrusted, REQ-1). Registration is the ENFORCEMENT POINT for
// the platform's hard gate: no request-time arbitrary code in the render path, per-user content =
// islands only. A widget that fails inference, uses a banned filter, or lands on the per-user tier
// without being an island is rejected AT REGISTRATION — mechanically, not by review (REQ-3).
//
// Versions are immutable: re-registering a type appends a new version, it never mutates the old
// one. Pages pin the version they were built with, so a widget update can't silently change
// already-published pages (they re-render on their own edit→purge cycle).

import { compile, render, UNTRUSTED_LIMITS, FILTER_ALLOWLIST } from '../liquid-render/engine';
import { renderUntrusted } from '../liquid-render/isolate';
import { inferTier, type Binding, type Tier } from '../liquid-render/infer';
import { FIRST_PARTY_WIDGETS } from '../liquid-render/widgets';

export interface WidgetInput {
  type: string;
  template: string; // Liquid source
  bindings: Binding[];
  // an island widget's TEMPLATE renders only the placeholder shell; its per-user content comes
  // from the island endpoint at hydration time (never into the cached page)
  island?: { name: string };
}

export interface WidgetRecord extends WidgetInput {
  version: number;
  trusted: boolean;
  tier: Tier; // INFERRED, never author-declared (REQ-3)
}

export class WidgetRejected extends Error {
  constructor(
    public reasons: string[],
    type: string
  ) {
    super(`widget '${type}' rejected: ${reasons.join('; ')}`);
  }
}

export class WidgetRegistry {
  // type → versions (index i = version i+1); records are frozen on insert
  private byType = new Map<string, WidgetRecord[]>();

  // Register a widget. `trusted:false` = merchant/app code (REQ-1): compiled under the sandboxed
  // engine (filter allowlist enforced at parse) and rendered only via the worker isolate (D40).
  register(input: WidgetInput, opts: { trusted: boolean }): WidgetRecord {
    // 1. inference gate (REQ-3): undeclared reads / unresolved includes reject regardless of trust —
    //    first-party code obeys the same contract merchants do, that's what makes it forkable.
    const inf = inferTier(input.template, input.bindings);
    if (!inf.ok) throw new WidgetRejected(inf.reasons, input.type);

    // 2. filter allowlist for untrusted code — enforced HERE, not left to render time. LiquidJS
    //    strictFilters only errors when the filter is evaluated, so a banned filter behind an
    //    {% if %} could pass a smoke render and detonate in production. Registration is parse-time.
    if (!opts.trusted) {
      const banned = inf.usedFilters.filter((f) => !(f in FILTER_ALLOWLIST));
      if (banned.length)
        throw new WidgetRejected([`non-allowlisted filters: ${banned.join(', ')}`], input.type);
    }

    // 3. the hard gate: per-user tier may ONLY exist behind an island. A shell widget whose
    //    template lands on per-user would bake user A's bytes into the shared cache (C2).
    if (inf.tier === 'per-user' && !input.island) {
      throw new WidgetRejected(
        [`effective tier is per-user — per-user content must be an island, not shell markup`],
        input.type
      );
    }

    // 4. compile under the target trust level — enforces syntax + parseLimit (oversized source).
    try {
      compile(input.template, { trusted: opts.trusted, limits: UNTRUSTED_LIMITS });
    } catch (e) {
      throw new WidgetRejected([`compile failed: ${(e as Error).message}`], input.type);
    }

    const versions = this.byType.get(input.type) ?? [];
    const rec: WidgetRecord = Object.freeze({
      ...input,
      version: versions.length + 1,
      trusted: opts.trusted,
      tier: inf.tier,
    });
    versions.push(rec);
    this.byType.set(input.type, versions);
    return rec;
  }

  // latest version, or a pinned one. Absent → undefined (callers decide reject vs fallback).
  get(type: string, version?: number): WidgetRecord | undefined {
    const versions = this.byType.get(type);
    if (!versions) return undefined;
    return version == null ? versions[versions.length - 1] : versions[version - 1];
  }

  list(): WidgetRecord[] {
    return [...this.byType.values()].map((v) => v[v.length - 1]);
  }
}

// Render one widget instance. Trust decides the path: first-party renders in-process (cooperative
// limits suffice for our own code); untrusted goes through the worker isolate with the hard
// wall-clock kill (D40) — one hostile template must never starve reserved-path serving.
export async function renderWidget(
  rec: WidgetRecord,
  data: Record<string, unknown>
): Promise<string> {
  if (rec.trusted) return render(rec.template, data, { trusted: true });
  return renderUntrusted(rec.template, data);
}

// A registry preloaded with the first-party library (Track 2 widgets), trusted, as version 1.
export function defaultRegistry(): WidgetRegistry {
  const reg = new WidgetRegistry();
  for (const w of Object.values(FIRST_PARTY_WIDGETS)) {
    reg.register({ type: w.type, template: w.template, bindings: w.bindings }, { trusted: true });
  }
  return reg;
}
