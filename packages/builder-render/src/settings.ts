// Typed settings schema (Slice 2b) — the editor's input contract. Each SettingDef types one
// editable field, addressed by a dotted `key` into the section/block instance data (e.g.
// 'hero.heading'). Save-time validation checks provided values against their declared type; the
// same schema tells the editor which control to render. Settings are authored config (static by
// construction) — data-source bindings (product, price, cart…) stay separate and carry the tier.

export type SettingType =
  | 'text'
  | 'richtext'
  | 'image'
  | 'url'
  | 'number'
  | 'range'
  | 'color'
  | 'select'
  | 'checkbox'
  | 'product'
  | 'collection';

export interface SettingDef {
  key: string; // dotted path into the instance data, e.g. 'hero.heading'
  type: SettingType;
  label?: string;
  default?: unknown;
  options?: string[]; // for 'select'
  min?: number; // for 'number' | 'range'
  max?: number;
}

function getPath(data: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (o, k) =>
        o != null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
      data
    );
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Returns a list of problems (empty = ok). A missing value is allowed — the field is optional and
// the editor supplies its default; we only type-check values that are actually present.
export function validateSettings(data: Record<string, unknown>, defs: SettingDef[]): string[] {
  const problems: string[] = [];
  for (const d of defs) {
    const v = getPath(data, d.key);
    if (v === undefined || v === null) continue;
    const bad = (msg: string) => problems.push(`setting '${d.key}' ${msg}`);
    switch (d.type) {
      case 'text':
      case 'richtext':
      case 'image':
      case 'product':
      case 'collection':
        if (typeof v !== 'string') bad(`must be a string (${d.type})`);
        break;
      case 'url':
        if (typeof v !== 'string') bad('must be a string (url)');
        else if (!/^(https?:\/\/|\/)/.test(v)) bad('must be an absolute URL or root-relative path');
        break;
      case 'color':
        if (typeof v !== 'string' || !HEX.test(v)) bad('must be a hex color like #1a2b3c');
        break;
      case 'select':
        if (typeof v !== 'string' || (d.options && !d.options.includes(v)))
          bad(`must be one of: ${(d.options ?? []).join(', ')}`);
        break;
      case 'number':
      case 'range':
        if (typeof v !== 'number' || Number.isNaN(v)) bad('must be a number');
        else if (d.min != null && v < d.min) bad(`must be >= ${d.min}`);
        else if (d.max != null && v > d.max) bad(`must be <= ${d.max}`);
        break;
      case 'checkbox':
        if (typeof v !== 'boolean') bad('must be true or false');
        break;
    }
  }
  return problems;
}
