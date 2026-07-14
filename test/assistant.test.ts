// OFCE-400 Model A: the in-dashboard assistant runs a Claude tool-use loop that drives the
// real control-plane through the generated SDK. Here the LLM boundary is mocked with a
// scripted fake (deterministic, no network, no key) while the control plane and DB are real
// — proving the loop wiring, tool execution, scoping, and audit end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.AGENT_TOKEN_SECRET = 'test-assistant-secret';
process.env.PLATFORM_ADMIN_IDS = '';

import type AnthropicSdk from '@anthropic-ai/sdk';
import { createApp } from '../services/admin-api/app';
import {
  composeVerifiers,
  agentVerifier,
  mintAgentToken,
  type Verifier,
} from '../services/admin-api/auth';
import { runAssistant, type AnthropicLike } from '../services/admin-api/assistant';
import { RatioControlPlane } from '@ratio/control-plane-client';
import { recentAudit } from '../services/admin-api/audit';
import { pool } from '../packages/shared/db';

const ALICE = 'user_alice_assistant';
const ID = 't_ai';
const humanVerifier: Verifier = async (t) => (t === 'tok-alice' ? { userId: ALICE } : null);
const app = createApp(composeVerifiers(agentVerifier, humanVerifier));

const viaApp: typeof fetch = ((url: string | URL | Request, init?: RequestInit) =>
  app.fetch(new Request(url as string, init))) as typeof fetch;

// A merchant-scoped token, exactly as the /assistant route mints internally.
const agentToken = mintAgentToken({
  sub: ALICE,
  scope: ['*'],
  exp: Math.floor(Date.now() / 1000) + 900,
});
const client = new RatioControlPlane({ baseUrl: 'http://cp', token: agentToken, fetch: viaApp });

// Build an Anthropic.Message from a scripted content list; casts fill the fields our loop
// doesn't read.
function message(content: unknown[], stop_reason: string): AnthropicSdk.Message {
  return { content, stop_reason } as unknown as AnthropicSdk.Message;
}

// A fake that replays a fixed script of assistant turns, ignoring the prompt — it lets us
// assert the loop executes each tool_use against the real API and threads results back.
function scriptedAnthropic(turns: AnthropicSdk.Message[]): AnthropicLike {
  let i = 0;
  return {
    messages: {
      create: async () => turns[i++],
    },
  };
}

async function cleanup() {
  await pool.query('DELETE FROM audit_log WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM routes WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM domains WHERE tenant_id=$1', [ID]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [ID]);
}
before(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

test('the assistant onboards a store and adds a page via the real control plane', async () => {
  const anthropic = scriptedAnthropic([
    message(
      [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'create_store',
          input: { id: ID, name: 'AI Shop', host: 'ai.localhost' },
        },
      ],
      'tool_use'
    ),
    message(
      [
        {
          type: 'tool_use',
          id: 'tu_2',
          name: 'add_or_edit_page',
          input: { storeId: ID, path: '/about', pageConfig: { title: 'About', sections: [] } },
        },
      ],
      'tool_use'
    ),
    message([{ type: 'text', text: 'Created AI Shop and added an About page.' }], 'end_turn'),
  ]);

  const result = await runAssistant({
    anthropic,
    client,
    message: 'Onboard AI Shop at ai.localhost (id t_ai) and add an About page.',
  });

  assert.match(result.reply, /About/);
  assert.strictEqual(result.actions.length, 2);
  assert.ok(result.actions.every((a) => a.ok));
  assert.deepStrictEqual(
    result.actions.map((a) => a.tool),
    ['create_store', 'add_or_edit_page']
  );

  // The edits are real: the store and page exist in the database.
  const { rows: tenants } = await pool.query('SELECT id, name FROM tenants WHERE id=$1', [ID]);
  assert.strictEqual(tenants[0]?.name, 'AI Shop');
  const { rows: routes } = await pool.query('SELECT path FROM routes WHERE tenant_id=$1', [ID]);
  assert.ok(routes.some((r) => r.path === '/about'));

  // And they are attributed to an agent actor in the audit trail (ADR-016).
  const audit = await recentAudit(ID);
  assert.ok(audit.some((e) => e.action === 'pages:write' && e.actorKind === 'agent'));
});

test('a failed tool call is reported back and does not abort the loop', async () => {
  const anthropic = scriptedAnthropic([
    // Editing a store the caller has no membership on → the API rejects it.
    message(
      [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'add_or_edit_page',
          input: { storeId: 't_not_mine', path: '/x', pageConfig: { sections: [] } },
        },
      ],
      'tool_use'
    ),
    message(
      [{ type: 'text', text: "I couldn't edit that store — you don't have access." }],
      'end_turn'
    ),
  ]);

  const result = await runAssistant({
    anthropic,
    client,
    message: 'Add a page to t_not_mine',
  });

  assert.strictEqual(result.actions.length, 1);
  assert.strictEqual(result.actions[0].ok, false);
  assert.match(result.reply, /access/i);
});
