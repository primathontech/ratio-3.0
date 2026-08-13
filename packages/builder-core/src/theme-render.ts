// Render a page from a compiled theme bundle (LLD BC5): read the page template (which sections + each
// section's data) and each section's Liquid from the bundle, render every section with its OWN data
// context, and concatenate — the same per-section-data model as composePage.
//
// The section renderer is INJECTED. In-process rendering of UNTRUSTED merchant Liquid is unsafe
// (D4 — no hard wall-clock kill, engine-bug exposure), so the origin passes an isolate-backed
// renderer (@ratio/builder-render/isolate) for merchant sections; a first-party/trusted path may pass
// an in-process one. This module is pure composition and never renders in-process itself.
import type { ThemeFiles } from './bundle';

// Renders one THEME section's Liquid with its data context to HTML. Theme sections (base or merchant)
// carry their Liquid in the bundle; for untrusted merchant sections this MUST run inside the
// worker-thread isolate — the caller owns that decision.
export type SectionRenderer = (liquid: string, data: Record<string, unknown>) => Promise<string>;

// Renders a PLATFORM (first-party, trusted) section by its type. A platform section's markup lives in
// central code (the section registry), not the bundle — so it's referenced by type, never forked or
// sandboxed. The caller wires the registry.
export type PlatformRenderer = (type: string, data: Record<string, unknown>) => Promise<string>;

// The two render strategies a page dispatches between (LLD R2 / the "two section flavors"): theme
// sections render their bundled Liquid, platform sections render from code.
export interface SectionRenderers {
  theme: SectionRenderer;
  platform?: PlatformRenderer;
}

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
// Each section dispatches on whether the bundle carries Liquid for its type: present → a THEME section
// (render its Liquid); absent → a PLATFORM section (render by type from code). A platform section with
// no platform renderer wired is an error, same as a missing theme section.
export async function renderThemePage(
  compiled: ThemeFiles,
  page: string,
  renderers: SectionRenderers
): Promise<string> {
  const raw = compiled[templatePath(page)];
  if (raw == null) throw new Error(`no template for page '${page}'`);
  const tpl = JSON.parse(raw) as PageTemplate;

  const parts: string[] = [];
  for (const inst of tpl.sections) {
    const liquid = compiled[sectionPath(inst.type)];
    const data = inst.data ?? {};
    if (liquid != null) {
      parts.push(await renderers.theme(liquid, data));
    } else if (renderers.platform) {
      parts.push(await renderers.platform(inst.type, data));
    } else {
      throw new Error(`no section '${inst.type}' in the theme`);
    }
  }
  return parts.join('\n');
}
