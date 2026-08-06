import type Anthropic from '@anthropic-ai/sdk';
import type { RatioControlPlane } from '@ratio/control-plane-client';
import { ControlPlaneError } from '@ratio/control-plane-client';

// OFCE-400 Model A: an in-dashboard AI assistant. It does NOT re-implement onboarding or
// editing (ADR-014 D-STR7) — it drives the SAME control-plane the dashboard uses, via the
// generated SDK, with a merchant-scoped agent token minted by the route. So every edit it
// makes is authorized by the caller's memberships and lands in the audit trail as an agent
// actor. Claude runs a server-side tool-use loop; the ANTHROPIC key never leaves the server.

// Injected so the loop is testable with a scripted fake (real DB, mocked LLM boundary).
export type AnthropicLike = {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
};

export interface AssistantAction {
  tool: string;
  input: unknown;
  ok: boolean;
}
export interface AssistantResult {
  reply: string;
  actions: AssistantAction[];
}

export const ASSISTANT_MODEL = 'claude-sonnet-5';
const MAX_STEPS = 8;

// Least privilege (audit N1): when the assistant is opened on a specific store, its agent
// token is scoped to THAT store only — so a prompt-injected or buggy agent can't reach the
// merchant's other stores. Only the onboarding entry point (no store yet) gets '*', which
// is what create_store needs.
export function scopeForAssistant(storeId?: string): string[] {
  return storeId ? [storeId] : ['*'];
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_stores',
    description: "List the stores the merchant can manage. Use this to find a store's id.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_store',
    description:
      'Onboard a new store. The merchant becomes its owner and it goes live immediately at its host.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Short slug id, e.g. t_acme' },
        name: { type: 'string', description: 'Display name, e.g. Acme' },
        host: { type: 'string', description: 'Domain, e.g. acme.ratiodev.in' },
        color: { type: 'string', description: 'Accent colour hex, optional' },
      },
      required: ['id', 'name', 'host'],
    },
  },
  {
    name: 'get_store',
    description: 'Read one store by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'add_or_edit_page',
    description:
      'Author a page with the page builder and publish it. Provide a PageDoc (see the system prompt for its shape and the valid section types). The draft is saved, validated, then published — the change goes live on the storefront immediately. If the PageDoc is invalid you get the validation error back so you can correct it and retry.',
    input_schema: {
      type: 'object',
      properties: {
        storeId: { type: 'string' },
        path: {
          type: 'string',
          description: 'Must start with /, e.g. /about. Must match doc.path.',
        },
        doc: {
          type: 'object',
          description: 'A PageDoc: { path, title?, dataSources?, sections: [...] }',
        },
      },
      required: ['storeId', 'path', 'doc'],
    },
  },
  {
    name: 'connect_domain',
    description: "Map a merchant's own domain to a store and start SSL provisioning.",
    input_schema: {
      type: 'object',
      properties: { storeId: { type: 'string' }, host: { type: 'string' } },
      required: ['storeId', 'host'],
    },
  },
];

const SYSTEM = `You are Ratio's storefront assistant, embedded in the merchant admin dashboard.
You help merchants onboard a store and edit its pages by calling the tools — never by
describing steps for them to do by hand. The tools drive the same live control plane the
dashboard uses, so your edits take effect immediately.

Conventions:
- Store ids are short slugs like t_acme. Hosts look like acme.ratiodev.in.
- Prefer list_stores to discover an id before editing an existing store.

Pages are authored with the page builder as a PageDoc and published immediately, so every
edit to a page goes live on the storefront at once. A PageDoc is:
  { path: "/about", title?: "About", dataSources?: {...}, sections: [ ... ] }
Each section is { id, type, dataSourceKey?, data }. Put a section's settings under
data.<binding>. Valid section types and their data shape:
- hero        -> data: { hero: { heading, sub?, cta?: { label, href } } }
- richText    -> data: { rich: { html } }
- heading     -> data: { heading: { text } }
- image       -> data: { image: { src, alt? } }
- button      -> data: { button: { label, href } }
- spacer      -> data: { spacer: { size } }   // height in px
- productGrid -> data: { grid: { heading? } }, with dataSourceKey pointing at a COLLECTION data source
- product     -> data: {}, with dataSourceKey pointing at a PRODUCT data source
Unknown section types are rejected — if add_or_edit_page returns an error, read the detail,
fix the PageDoc, and retry. Example doc for an About page:
  { path: "/about", title: "About us", sections: [
    { id: "h", type: "hero", data: { hero: { heading: "About us", sub: "Our story" } } },
    { id: "body", type: "richText", data: { rich: { html: "<p>We started in 2020.</p>" } } }
  ] }

Be concise. When you finish, tell the merchant plainly what you changed and the store URL.`;

async function runTool(
  client: RatioControlPlane,
  name: string,
  input: Record<string, unknown>
): Promise<{ ok: boolean; result: unknown }> {
  try {
    switch (name) {
      case 'list_stores':
        return { ok: true, result: await client.listStores() };
      case 'create_store':
        return {
          ok: true,
          result: await client.createStore({
            id: input.id as string,
            name: input.name as string,
            host: input.host as string,
            color: input.color as string | undefined,
          }),
        };
      case 'get_store':
        return { ok: true, result: await client.getStore(input.id as string) };
      case 'add_or_edit_page': {
        const storeId = input.storeId as string;
        const path = input.path as string;
        const doc = input.doc as Parameters<RatioControlPlane['savePageDraft']>[1];
        const saved = await client.savePageDraft(storeId, doc);
        const published = await client.publishPage(storeId, path);
        return { ok: true, result: { saved, published } };
      }
      case 'connect_domain':
        return {
          ok: true,
          result: await client.connectDomain(input.storeId as string, input.host as string),
        };
      default:
        return { ok: false, result: { error: `unknown tool: ${name}` } };
    }
  } catch (e) {
    const detail = (e as ControlPlaneError).body as { detail?: string } | undefined;
    return {
      ok: false,
      result: { error: (e as Error).message, ...(detail?.detail && { detail: detail.detail }) },
    };
  }
}

export async function runAssistant(opts: {
  anthropic: AnthropicLike;
  client: RatioControlPlane;
  message: string;
  storeId?: string;
}): Promise<AssistantResult> {
  const { anthropic, client, message, storeId } = opts;
  const system = storeId
    ? `${SYSTEM}\n\nThe merchant is currently viewing store ${storeId}.`
    : SYSTEM;

  // With a store already open the token is store-scoped, so onboarding is out of scope —
  // don't offer create_store (it would only 403). Onboarding sessions (no storeId) keep it.
  const tools = storeId ? TOOLS.filter((t) => t.name !== 'create_store') : TOOLS;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: message }];
  const actions: AssistantAction[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await anthropic.messages.create({
      model: ASSISTANT_MODEL,
      max_tokens: 4096,
      system,
      tools,
      messages,
    });
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason !== 'tool_use') {
      const reply = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return { reply, actions };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      const { ok, result } = await runTool(
        client,
        block.name,
        (block.input ?? {}) as Record<string, unknown>
      );
      actions.push({ tool: block.name, input: block.input, ok });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
        is_error: !ok,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    reply: "I've done as much as I can in one go — ask me to continue if there's more.",
    actions,
  };
}
