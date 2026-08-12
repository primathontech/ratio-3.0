// Render a page from a compiled theme bundle (LLD BC5): read the page template (which sections + each
// section's data) and each section's Liquid from the bundle, render every section with its OWN data
// context, and concatenate — the same per-section-data model as composePage.
//
// The section renderer is INJECTED. In-process rendering of UNTRUSTED merchant Liquid is unsafe
// (D4 — no hard wall-clock kill, engine-bug exposure), so the origin passes an isolate-backed
// renderer (@ratio/builder-render/isolate) for merchant sections; a first-party/trusted path may pass
// an in-process one. This module is pure composition and never renders in-process itself.
import type { ThemeFiles } from './bundle';

// Renders one section's Liquid with its data context to HTML. For untrusted (merchant) sections this
// MUST run inside the worker-thread isolate — the caller owns that decision.
export type SectionRenderer = (liquid: string, data: Record<string, unknown>) => Promise<string>;

interface SectionInstance {
  type: string;
  data?: Record<string, unknown>; // the section's render context (settings values + bound data)
}
interface PageTemplate {
  sections: SectionInstance[];
}

const templatePath = (page: string) => `templates/${page}.json`;
const sectionPath = (type: string) => `sections/${type}.liquid`;

// Render one page of a compiled bundle to HTML, section by section, each with its own data context.
export async function renderThemePage(
  compiled: ThemeFiles,
  page: string,
  renderSection: SectionRenderer
): Promise<string> {
  const raw = compiled[templatePath(page)];
  if (raw == null) throw new Error(`no template for page '${page}'`);
  const tpl = JSON.parse(raw) as PageTemplate;

  const parts: string[] = [];
  for (const inst of tpl.sections) {
    const liquid = compiled[sectionPath(inst.type)];
    if (liquid == null) throw new Error(`no section '${inst.type}' in the theme`);
    parts.push(await renderSection(liquid, inst.data ?? {}));
  }
  return parts.join('\n');
}
