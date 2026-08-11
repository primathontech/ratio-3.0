// OFCE-492 · proves the Puck↔PageDoc mapping round-trips losslessly across the AST's real shapes:
// flat, data-backed (dataSources + dataSourceKey + version pins), recursive blocks, and no-title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PageDoc } from '@ratio/builder-core';
import { pageDocToPuck, puckToPageDoc } from './puck-adapter';

const flat: PageDoc = {
  path: '/',
  title: 'Home',
  sections: [{ id: 'h', type: 'hero', version: 1, data: { hero: { heading: 'Hi' } } }],
};

const dataBacked: PageDoc = {
  path: '/collections/:handle',
  title: 'Collection',
  dataSources: { main: { type: 'COLLECTION', params: { handle: '{{params.handle}}' } } },
  sections: [
    {
      id: 'g',
      type: 'productGrid',
      version: 1,
      dataSourceKey: 'main',
      data: { grid: { heading: 'Shop' } },
    },
  ],
};

const nested: PageDoc = {
  path: '/',
  title: 'Features',
  sections: [
    {
      id: 'row',
      type: 'iconRow',
      version: 1,
      data: { row: { heading: 'Why us' } },
      blocks: [
        { id: 'b1', type: 'iconItem', version: 1, data: { item: { label: 'Fast' } } },
        { id: 'b2', type: 'iconItem', version: 1, data: { item: { label: 'Safe' } } },
      ],
    },
  ],
};

const noTitle: PageDoc = {
  path: '/about',
  sections: [{ id: 'a', type: 'hero', version: 1, data: {} }],
};

for (const [name, doc] of Object.entries({ flat, dataBacked, nested, noTitle })) {
  test(`round-trips losslessly: ${name}`, () => {
    assert.deepStrictEqual(puckToPageDoc(pageDocToPuck(doc)), doc);
  });
}

test('nesting maps to a Puck zone keyed by the parent id', () => {
  const puck = pageDocToPuck(nested);
  assert.equal(puck.content.length, 1, 'one top-level section in content');
  assert.ok(puck.zones['row:blocks'], 'child blocks live in the parent zone');
  assert.equal(puck.zones['row:blocks'].length, 2);
});

test('data-backed section carries dataSourceKey + version through props; sources on root', () => {
  const puck = pageDocToPuck(dataBacked);
  assert.equal(puck.content[0].props.dataSourceKey, 'main');
  assert.equal(puck.content[0].props.version, 1);
  assert.ok(
    (puck.root.props as { dataSources?: unknown }).dataSources,
    'page dataSources on Puck root'
  );
});
