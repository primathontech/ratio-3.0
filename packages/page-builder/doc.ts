// Page document (Track 4) — what the editor edits and the origin renders. A page is an ordered
// list of widget INSTANCES: a pinned widget (type@version) plus the data it binds. Validation at
// save time is the second enforcement point after registration (REQ-3): an instance may only
// supply data for its widget's DECLARED bindings — there is no side door for extra data to reach
// a template, so inference done at registration stays true at render.

import type { WidgetRegistry } from '../widget-registry/registry';
import { canonicalPath } from '../spine/canonical-key';

export interface WidgetInstance {
  id: string; // unique within the page — stable identity for the editor + island params
  type: string;
  version?: number; // pinned at save; absent in editor input = pin latest
  data: Record<string, unknown>; // keys MUST be ⊆ the widget's declared bindings
}

export interface PageDoc {
  path: string; // canonical path (validated below)
  title?: string;
  widgets: WidgetInstance[];
}

// Reserved paths can never host built pages — they are the no-store lane (P8).
const RESERVED = ['/cart', '/checkout', '/account', '/api', '/preview'];

export class InvalidPageDoc extends Error {
  constructor(public problems: string[]) {
    super(`invalid page doc: ${problems.join('; ')}`);
  }
}

// Validate + normalize: returns the doc with canonicalized path and every widget version PINNED
// (so a later widget update can't silently change this page — it re-renders only on its own
// edit→purge cycle). Throws InvalidPageDoc listing every problem at once (editor UX).
export function validatePageDoc(doc: PageDoc, registry: WidgetRegistry): PageDoc {
  const problems: string[] = [];

  const path = canonicalPath(doc.path ?? '');
  if (!path.startsWith('/')) problems.push(`path must be absolute, got '${doc.path}'`);
  if (RESERVED.some((r) => path === r || path.startsWith(r + '/')))
    problems.push(`path '${path}' is reserved`);

  const seen = new Set<string>();
  const widgets: WidgetInstance[] = [];
  for (const w of doc.widgets ?? []) {
    if (!w.id || seen.has(w.id)) {
      problems.push(`widget id '${w.id}' missing or duplicate`);
      continue;
    }
    seen.add(w.id);

    const rec = registry.get(w.type, w.version);
    if (!rec) {
      problems.push(`unknown widget '${w.type}'${w.version ? `@${w.version}` : ''}`);
      continue;
    }
    const declared = new Set(rec.bindings.map((b) => b.name));
    const extra = Object.keys(w.data ?? {}).filter((k) => !declared.has(k));
    if (extra.length)
      problems.push(`widget '${w.id}' (${w.type}) supplies undeclared data: ${extra.join(', ')}`);

    widgets.push({ ...w, version: rec.version, data: w.data ?? {} });
  }

  if (problems.length) throw new InvalidPageDoc(problems);
  return { path, title: doc.title, widgets };
}
