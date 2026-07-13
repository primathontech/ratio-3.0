import { Icon } from './ui';

// Visual editor for the storefront content model. Mirrors packages/content-model on the
// UI side: sections are the editing contract; the theme renders whatever we produce.

export type ProductCard = { title?: string; price?: string; href?: string; image?: string };
export type Section =
  | { kind: 'hero'; heading?: string; sub?: string; cta?: { label?: string; href?: string } }
  | { kind: 'richText'; html?: string }
  | { kind: 'productGrid'; heading?: string; products?: ProductCard[] }
  | { kind: 'product'; title?: string; price?: string; description?: string; image?: string };
export type PageConfig = { title?: string; sections: Section[] };

export const SECTION_TYPES: { kind: Section['kind']; label: string; make: () => Section }[] = [
  { kind: 'hero', label: 'Hero', make: () => ({ kind: 'hero', heading: 'New heading', sub: '' }) },
  {
    kind: 'productGrid',
    label: 'Product grid',
    make: () => ({ kind: 'productGrid', heading: 'Products', products: [] }),
  },
  {
    kind: 'product',
    label: 'Product',
    make: () => ({ kind: 'product', title: 'New product', price: 'Rs 0' }),
  },
  { kind: 'richText', label: 'Rich text', make: () => ({ kind: 'richText', html: '<p></p>' }) },
];

// Accept both the new {sections} shape and legacy {title, body, price} rows.
export function toEditable(pc: unknown): PageConfig {
  const o = (pc ?? {}) as Record<string, unknown>;
  if (Array.isArray(o.sections)) return { title: (o.title as string) ?? '', sections: o.sections as Section[] };
  const sections: Section[] = [];
  if (o.price) {
    sections.push({ kind: 'product', title: o.title as string, price: o.price as string, description: o.body as string });
  } else if (o.title) {
    sections.push({ kind: 'hero', heading: o.title as string, sub: (o.body as string) ?? '' });
  } else if (o.body) {
    sections.push({ kind: 'richText', html: `<p>${o.body as string}</p>` });
  }
  return { title: (o.title as string) ?? '', sections };
}

function TextInput(props: { value?: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <input
      className={props.mono ? 'input mono' : 'input'}
      value={props.value ?? ''}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

function ProductsEditor({ items, onChange }: { items: ProductCard[]; onChange: (p: ProductCard[]) => void }) {
  const set = (i: number, patch: Partial<ProductCard>) =>
    onChange(items.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="products-editor">
      {items.map((p, i) => (
        <div className="product-row" key={i}>
          <TextInput value={p.title} placeholder="Title" onChange={(v) => set(i, { title: v })} />
          <TextInput value={p.price} placeholder="Price" onChange={(v) => set(i, { price: v })} />
          <TextInput value={p.href} placeholder="/link" mono onChange={(v) => set(i, { href: v })} />
          <button
            type="button"
            className="icon-btn"
            aria-label="Remove product"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            <Icon.trash size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => onChange([...items, { title: 'New product', price: 'Rs 0', href: '/' }])}
      >
        <Icon.plus size={14} /> Add product
      </button>
    </div>
  );
}

function SectionFields({ section, onChange }: { section: Section; onChange: (s: Section) => void }) {
  switch (section.kind) {
    case 'hero':
      return (
        <div className="sec-fields">
          <label className="field">
            <span>Heading</span>
            <TextInput value={section.heading} onChange={(v) => onChange({ ...section, heading: v })} />
          </label>
          <label className="field">
            <span>Subheading</span>
            <TextInput value={section.sub} onChange={(v) => onChange({ ...section, sub: v })} />
          </label>
          <div className="row">
            <label className="field">
              <span>Button label</span>
              <TextInput
                value={section.cta?.label}
                onChange={(v) => onChange({ ...section, cta: { ...section.cta, label: v } })}
              />
            </label>
            <label className="field">
              <span>Button link</span>
              <TextInput
                mono
                value={section.cta?.href}
                onChange={(v) => onChange({ ...section, cta: { ...section.cta, href: v } })}
              />
            </label>
          </div>
        </div>
      );
    case 'richText':
      return (
        <label className="field">
          <span>HTML</span>
          <textarea
            className="textarea"
            style={{ minHeight: 120 }}
            value={section.html ?? ''}
            onChange={(e) => onChange({ ...section, html: e.target.value })}
          />
        </label>
      );
    case 'productGrid':
      return (
        <div className="sec-fields">
          <label className="field">
            <span>Heading</span>
            <TextInput value={section.heading} onChange={(v) => onChange({ ...section, heading: v })} />
          </label>
          <ProductsEditor
            items={section.products ?? []}
            onChange={(products) => onChange({ ...section, products })}
          />
        </div>
      );
    case 'product':
      return (
        <div className="sec-fields">
          <div className="row">
            <label className="field">
              <span>Title</span>
              <TextInput value={section.title} onChange={(v) => onChange({ ...section, title: v })} />
            </label>
            <label className="field">
              <span>Price</span>
              <TextInput value={section.price} onChange={(v) => onChange({ ...section, price: v })} />
            </label>
          </div>
          <label className="field">
            <span>Description</span>
            <TextInput value={section.description} onChange={(v) => onChange({ ...section, description: v })} />
          </label>
        </div>
      );
  }
}

export function SectionEditor({
  sections,
  onChange,
}: {
  sections: Section[];
  onChange: (s: Section[]) => void;
}) {
  const update = (i: number, s: Section) => onChange(sections.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const label = (k: Section['kind']) => SECTION_TYPES.find((t) => t.kind === k)?.label ?? k;

  return (
    <div className="sections">
      {sections.length === 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          No sections yet — add one below to build this page.
        </p>
      )}
      {sections.map((s, i) => (
        <div className="sec-card" key={i}>
          <div className="sec-head">
            <span className="badge badge-accent">{label(s.kind)}</span>
            <div className="sec-actions">
              <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <Icon.up size={14} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Move down"
                disabled={i === sections.length - 1}
                onClick={() => move(i, 1)}
              >
                <Icon.down size={14} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Delete section"
                onClick={() => onChange(sections.filter((_, j) => j !== i))}
              >
                <Icon.trash size={14} />
              </button>
            </div>
          </div>
          <SectionFields section={s} onChange={(ns) => update(i, ns)} />
        </div>
      ))}
      <div className="add-section">
        {SECTION_TYPES.map((t) => (
          <button key={t.kind} type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...sections, t.make()])}>
            <Icon.plus size={13} /> {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
