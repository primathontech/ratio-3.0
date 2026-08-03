// Page document (Track 4) — what the editor edits and the origin renders. A page is an ordered
// list of section INSTANCES: a pinned section (type@version) plus the data it binds. Validation at
// save time is the second enforcement point after registration (REQ-3): an instance may only
// supply data for its section's DECLARED bindings — there is no side door for extra data to reach
// a template, so inference done at registration stays true at render.

import type { SectionRegistry } from '../section-registry/registry';
import { BINDING_CATALOG } from '../section-registry/registry';
import { canonicalPath } from './path';
import { safeRichText } from '../theme/index';

export interface SectionInstance {
  id: string; // unique within the page — stable identity for the editor + island params
  type: string;
  version?: number; // pinned at save; absent in editor input = pin latest
  data: Record<string, unknown>; // keys MUST be ⊆ the section's declared bindings
}

export interface PageDoc {
  path: string; // canonical path (validated below)
  title?: string;
  sections: SectionInstance[];
}

// Reserved paths can never host built pages — they are the no-store lane (P8).
const RESERVED = ['/cart', '/checkout', '/account', '/api', '/preview'];

export class InvalidPageDoc extends Error {
  constructor(public problems: string[]) {
    super(`invalid page doc: ${problems.join('; ')}`);
  }
}

// Every string inside an html-flagged binding value goes through the theme's escape-then-restore
// sanitizer (allowlisted formatting tags only; attributes can never survive).
function sanitizeHtmlDeep(v: unknown): unknown {
  if (typeof v === 'string') return safeRichText(v);
  if (Array.isArray(v)) return v.map(sanitizeHtmlDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = sanitizeHtmlDeep(val);
    return out;
  }
  return v;
}

// Validate + normalize: returns the doc with canonicalized path and every section version PINNED
// (so a later section update can't silently change this page — it re-renders only on its own
// edit→purge cycle). Throws InvalidPageDoc listing every problem at once (editor UX).
export function validatePageDoc(doc: PageDoc, registry: SectionRegistry): PageDoc {
  const problems: string[] = [];

  const path = canonicalPath(doc.path ?? '');
  if (!path.startsWith('/')) problems.push(`path must be absolute, got '${doc.path}'`);
  if (RESERVED.some((r) => path === r || path.startsWith(r + '/')))
    problems.push(`path '${path}' is reserved`);

  const seen = new Set<string>();
  const sections: SectionInstance[] = [];
  for (const w of doc.sections ?? []) {
    if (!w.id || seen.has(w.id)) {
      problems.push(`section id '${w.id}' missing or duplicate`);
      continue;
    }
    seen.add(w.id);

    const rec = registry.get(w.type, w.version);
    if (!rec) {
      problems.push(`unknown section '${w.type}'${w.version ? `@${w.version}` : ''}`);
      continue;
    }
    const declared = new Set(rec.bindings.map((b) => b.name));
    const extra = Object.keys(w.data ?? {}).filter((k) => !declared.has(k));
    if (extra.length)
      problems.push(`section '${w.id}' (${w.type}) supplies undeclared data: ${extra.join(', ')}`);

    // html-flagged bindings (catalog) carry authored rich HTML — sanitize AT SAVE, so the raw
    // markup never reaches storage or a template. The template's {{ rich.html }} stays raw-output
    // by design; safety lives in the data, enforced here (review finding #8).
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(w.data ?? {})) {
      data[k] = BINDING_CATALOG[k]?.html ? sanitizeHtmlDeep(v) : v;
    }

    sections.push({ ...w, version: rec.version, data });
  }

  if (problems.length) throw new InvalidPageDoc(problems);
  return { path, title: doc.title, sections };
}
