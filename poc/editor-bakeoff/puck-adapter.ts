// OFCE-492 editor bake-off · the make-or-break evidence: does Puck's data model round-trip our
// PageDoc AST losslessly? This models Puck's published `Data` shape (root / content / zones) — no
// @measured/puck dependency needed to prove the mapping. A clean, lossless round-trip = Puck is a
// viable editor base; a lossy/awkward one = a mark against it. (The custom editor emits PageDoc
// natively — zero adapter — so its "AST fit" is perfect by construction; this measures Puck's.)
import type { PageDoc, SectionInstance, BlockInstance, DataSource } from '@ratio/builder-core';

// --- Puck's Data shape (as published by @measured/puck) ---
export interface PuckComponent {
  type: string;
  props: Record<string, unknown> & { id: string };
}
export interface PuckData {
  root: { props: Record<string, unknown> };
  content: PuckComponent[];
  zones: Record<string, PuckComponent[]>; // nesting: key = `${parentId}:${slot}`
}

// Our recursive Section→Block nesting maps to a Puck DropZone named `blocks` on the parent.
const BLOCK_SLOT = 'blocks';
const zoneKey = (parentId: string) => `${parentId}:${BLOCK_SLOT}`;

function sectionToComponent(s: SectionInstance): PuckComponent {
  return {
    type: s.type,
    props: {
      id: s.id,
      data: s.data,
      ...(s.version !== undefined ? { version: s.version } : {}),
      ...(s.dataSourceKey ? { dataSourceKey: s.dataSourceKey } : {}),
    },
  };
}
function blockToComponent(b: BlockInstance): PuckComponent {
  return {
    type: b.type,
    props: { id: b.id, data: b.data, ...(b.version !== undefined ? { version: b.version } : {}) },
  };
}

export function pageDocToPuck(doc: PageDoc): PuckData {
  const zones: Record<string, PuckComponent[]> = {};
  const content = doc.sections.map((s) => {
    if (s.blocks && s.blocks.length) zones[zoneKey(s.id)] = s.blocks.map(blockToComponent);
    return sectionToComponent(s);
  });
  return {
    root: {
      props: {
        path: doc.path,
        ...(doc.title !== undefined ? { title: doc.title } : {}),
        ...(doc.dataSources ? { dataSources: doc.dataSources } : {}),
      },
    },
    content,
    zones,
  };
}

function componentToBlock(c: PuckComponent): BlockInstance {
  const p = c.props as { id: string; data?: Record<string, unknown>; version?: number };
  return {
    id: p.id,
    type: c.type,
    data: p.data ?? {},
    ...(p.version !== undefined ? { version: p.version } : {}),
  };
}

export function puckToPageDoc(data: PuckData): PageDoc {
  const root = data.root.props as {
    title?: string;
    path?: string;
    dataSources?: Record<string, DataSource>;
  };
  const sections: SectionInstance[] = data.content.map((c) => {
    const p = c.props as {
      id: string;
      data?: Record<string, unknown>;
      version?: number;
      dataSourceKey?: string;
    };
    const blocks = data.zones[zoneKey(p.id)]?.map(componentToBlock);
    return {
      id: p.id,
      type: c.type,
      data: p.data ?? {},
      ...(p.version !== undefined ? { version: p.version } : {}),
      ...(p.dataSourceKey ? { dataSourceKey: p.dataSourceKey } : {}),
      ...(blocks && blocks.length ? { blocks } : {}),
    };
  });
  return {
    path: root.path ?? '/',
    ...('title' in root ? { title: root.title } : {}),
    ...(root.dataSources ? { dataSources: root.dataSources } : {}),
    sections,
  };
}
