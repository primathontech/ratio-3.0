// Page-builder authoring API (ADR-013 / D4). Draft -> publish over the real pages table, in
// process via app.fetch(). The verifier is injected (Clerk is the external boundary); the DB is
// real. A published PageDoc is what the origin serves — see page-builder-origin.test.ts.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../../services/admin-api/app';
import { onboardStore } from '@ratio/provisioning';
import { pool } from '@ratio/shared/db';

const OWNER = 'user_pb_owner';
const verify = async (token: string) => (token === 'tok-owner' ? { userId: OWNER } : null);
const app = createApp(verify);

const ID = 'pbauth';
const owner = { authorization: 'Bearer tok-owner' };

function call(method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request('http://cp' + path, {
      method,
      headers: { 'content-type': 'application/json', ...owner },
      body: body ? JSON.stringify(body) : undefined,
    })
  );
}

const validDoc = {
  path: '/',
  title: 'PB Home',
  sections: [
    {
      id: 'hero1',
      type: 'hero',
      data: { hero: { heading: 'Hello', sub: 'world', cta: { label: 'Shop', href: '/shop' } } },
    },
    { id: 'rt1', type: 'richText', data: { rich: { html: '<p>hi</p>' } } },
  ],
};

async function cleanup() {
  await pool.query('DELETE FROM page_purge_outbox WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM pages WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM routes WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM domains WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [ID]);
}
before(async () => {
  await cleanup();
  await onboardStore({ id: ID, name: 'PB Auth', host: `${ID}.localhost`, ownerUserId: OWNER });
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('non-member cannot touch the page builder', async () => {
  const r = await app.fetch(new Request('http://cp/stores/' + ID + '/page-builder?path=/'));
  assert.strictEqual(r.status, 401);
});

test('a fresh page has no draft or live', async () => {
  const r = await call('GET', `/stores/${ID}/page-builder?path=/`);
  assert.strictEqual(r.status, 200);
  const b = await r.json();
  assert.strictEqual(b.draft, null);
  assert.strictEqual(b.live, null);
  assert.strictEqual(b.revision, 0);
});

test('publish with no draft is a 404', async () => {
  const r = await call('POST', `/stores/${ID}/page-builder/publish`, { path: '/' });
  assert.strictEqual(r.status, 404);
});

test('an unknown section type is rejected (422), draft untouched', async () => {
  const r = await call('PUT', `/stores/${ID}/page-builder`, {
    doc: { path: '/', title: 'x', sections: [{ id: 's', type: 'notARealSection', data: {} }] },
  });
  assert.strictEqual(r.status, 422);
  const after = await (await call('GET', `/stores/${ID}/page-builder?path=/`)).json();
  assert.strictEqual(after.draft, null);
});

test('save draft -> publish -> live reflects the doc, revision bumps', async () => {
  const save = await call('PUT', `/stores/${ID}/page-builder`, { doc: validDoc });
  assert.strictEqual(save.status, 200);
  const saved = await save.json();
  assert.strictEqual(saved.draft.sections[0].version, 1); // versions pinned by validation

  const afterSave = await (await call('GET', `/stores/${ID}/page-builder?path=/`)).json();
  assert.strictEqual(afterSave.hasDraft, true);
  assert.strictEqual(afterSave.live, null); // draft only — live untouched until publish

  const pub = await call('POST', `/stores/${ID}/page-builder/publish`, { path: '/' });
  assert.strictEqual(pub.status, 200);
  assert.strictEqual((await pub.json()).revision, 1);

  const afterPub = await (await call('GET', `/stores/${ID}/page-builder?path=/`)).json();
  assert.strictEqual(afterPub.revision, 1);
  assert.strictEqual(afterPub.live.title, 'PB Home');
  assert.strictEqual(afterPub.live.sections.length, 2);
});

test('multi-page: a second page is created + listed with its publish state', async () => {
  await call('PUT', `/stores/${ID}/page-builder`, {
    doc: { path: '/about', title: 'About', sections: [] },
  });
  await call('POST', `/stores/${ID}/page-builder/publish`, { path: '/about' });
  const r = await call('GET', `/stores/${ID}/page-builder/pages`);
  assert.strictEqual(r.status, 200);
  const { pages } = await r.json();
  const about = pages.find((p: { path: string }) => p.path === '/about');
  assert.ok(about, '/about should be listed');
  assert.strictEqual(about.published, true);
  assert.strictEqual(about.revision, 1);
});

test('a section with child blocks validates + pins block versions + publishes', async () => {
  const doc = {
    path: '/slides',
    title: 'Slides',
    sections: [
      {
        id: 'ss',
        type: 'slideshow',
        data: {},
        blocks: [
          { id: 's1', type: 'slide', data: { slide: { heading: 'One' } } },
          { id: 's2', type: 'slide', data: { slide: { heading: 'Two' } } },
        ],
      },
    ],
  };
  assert.strictEqual((await call('PUT', `/stores/${ID}/page-builder`, { doc })).status, 200);
  await call('POST', `/stores/${ID}/page-builder/publish`, { path: '/slides' });
  const state = await (await call('GET', `/stores/${ID}/page-builder?path=/slides`)).json();
  assert.strictEqual(state.live.sections[0].blocks.length, 2);
  assert.strictEqual(state.live.sections[0].blocks[0].version, 1);
});

test('a block type the section does not accept is rejected (422)', async () => {
  const r = await call('PUT', `/stores/${ID}/page-builder`, {
    doc: {
      path: '/bad',
      title: 'x',
      sections: [
        { id: 'ss', type: 'slideshow', data: {}, blocks: [{ id: 'h', type: 'hero', data: {} }] },
      ],
    },
  });
  assert.strictEqual(r.status, 422);
});
