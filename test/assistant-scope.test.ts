// Audit N1: the in-dashboard assistant should run with LEAST privilege. When it's opened
// on a specific store, the internal agent token must be scoped to that store only (not '*'),
// so a prompt-injected or buggy agent can't reach the merchant's other stores or create new
// ones. Real control plane in-process; the LLM boundary is a scripted fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-scope-secret';
process.env.PLATFORM_ADMIN_IDS = '';

import type AnthropicSdk from '@anthropic-ai/sdk';
import { createApp } from '../services/admin-api/app';
import {
  composeVerifiers,
  agentVerifier,
  mintAgentToken,
  type Verifier,
} from '../services/admin-api/auth';
import {
  runAssistant,
  scopeForAssistant,
  type AnthropicLike,
} from '../services/admin-api/assistant';
import { RatioControlPlane } from '@ratio/control-plane-client';
import { pool } from '../packages/shared/db';

const OWNER = 'user_owner_scope';
const TS = 't_scope'; // the store the assistant is opened on
const OTHER = 't_scope_other'; // a store it must not be able to create/touch

const humans: Verifier = async (t) => (t === 'tok-owner' ? { userId: OWNER } : null);
const app = createApp(composeVerifiers(agentVerifier, humans));

const viaApp: typeof fetch = ((url: string | URL | Request, init?: RequestInit) =>
  app.fetch(new Request(url as string, init))) as typeof fetch;

function message(content: unknown[], stop_reason: string): AnthropicSdk.Message {
  return { content, stop_reason } as unknown as AnthropicSdk.Message;
}
function scripted(turns: AnthropicSdk.Message[]): AnthropicLike {
  let i = 0;
  return { messages: { create: async () => turns[i++] } };
}

async function cleanup() {
  for (const id of [TS, OTHER]) {
    await pool.query('DELETE FROM audit_log WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM routes WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM domains WHERE tenant_id=$1', [id]);
    await pool.query('DELETE FROM tenants WHERE id=$1', [id]);
  }
}
before(async () => {
  await cleanup();
  const r = await app.fetch(
    new Request('http://cp/stores', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-owner' },
      body: JSON.stringify({ id: TS, name: 'Scope Store', host: 'scope.localhost' }),
    })
  );
  assert.strictEqual(r.status, 201);
});
after(async () => {
  await cleanup();
  await pool.end();
});

test('scopeForAssistant: [storeId] when a store is open, ["*"] only for onboarding', () => {
  assert.deepStrictEqual(scopeForAssistant(TS), [TS]);
  assert.deepStrictEqual(scopeForAssistant(), ['*']);
  assert.deepStrictEqual(scopeForAssistant(undefined), ['*']);
});

test('a store-scoped assistant can edit its store but cannot create/reach another', async () => {
  const token = mintAgentToken({
    sub: OWNER,
    scope: scopeForAssistant(TS),
    exp: Math.floor(Date.now() / 1000) + 900,
  });
  const client = new RatioControlPlane({ baseUrl: 'http://cp', token, fetch: viaApp });

  const anthropic = scripted([
    // The (possibly injected) agent tries to create another store...
    message(
      [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'create_store',
          input: { id: OTHER, name: 'Other', host: 'other.localhost' },
        },
      ],
      'tool_use'
    ),
    // ...and edits the store it IS scoped to.
    message(
      [
        {
          type: 'tool_use',
          id: 'tu_2',
          name: 'add_or_edit_page',
          input: { storeId: TS, path: '/promo', pageConfig: { sections: [] } },
        },
      ],
      'tool_use'
    ),
    message([{ type: 'text', text: 'Done.' }], 'end_turn'),
  ]);

  const result = await runAssistant({ anthropic, client, message: 'edit my store', storeId: TS });

  const create = result.actions.find((a) => a.tool === 'create_store');
  const edit = result.actions.find((a) => a.tool === 'add_or_edit_page');
  assert.strictEqual(create?.ok, false, 'create_store must be rejected by the store scope');
  assert.strictEqual(edit?.ok, true, 'editing the in-scope store must succeed');

  // The other store was never created.
  const { rows } = await pool.query('SELECT id FROM tenants WHERE id=$1', [OTHER]);
  assert.strictEqual(rows.length, 0);
});
