// Render a page from a compiled theme bundle (LLD BC5): read the page template (which sections + their
// settings) and each section's Liquid from the bundle, render each with the bound data via the shared
// builder-render engine, and concatenate. Merchant (untrusted) sections render with the filter
// allowlist enforced; the origin wraps untrusted renders in the worker-thread isolate (D4) — this
// function is the composition layer, independent of where the render actually runs.
import { render } from '@ratio/builder-render';
import type { ThemeFiles } from './bundle';

interface SectionInstance {
  type: string;
  settings?: Record<string, unknown>;
}
interface PageTemplate {
  sections: SectionInstance[];
}

const templatePath = (page: string) => `templates/${page}.json`;
const sectionPath = (type: string) => `sections/${type}.liquid`;

export interface RenderThemeOpts {
  // default false (merchant sections): enforce the filter allowlist. First-party trusted sections
  // may pass true.
  trusted?: boolean;
}

// Render one page of a compiled bundle to HTML. `data` is the bound render context (shop, product,
// settings, ...); each section instance's settings are merged in for that section's render.
export async function renderThemePage(
  compiled: ThemeFiles,
  page: string,
  data: Record<string, unknown> = {},
  opts: RenderThemeOpts = {}
): Promise<string> {
  const raw = compiled[templatePath(page)];
  if (raw == null) throw new Error(`no template for page '${page}'`);
  const tpl = JSON.parse(raw) as PageTemplate;
  const trusted = opts.trusted ?? false;

  const parts: string[] = [];
  for (const inst of tpl.sections) {
    const liquid = compiled[sectionPath(inst.type)];
    if (liquid == null) throw new Error(`no section '${inst.type}' in the theme`);
    const ctx = { ...data, ...(inst.settings ?? {}) };
    parts.push(await render(liquid, ctx, { trusted }));
  }
  return parts.join('\n');
}
