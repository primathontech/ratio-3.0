// ADR-016 Phase 1 (OFCE-401): the control-plane API contract, source of truth for the
// generated SDK (scripts/gen-client.ts) and served at GET /openapi.json for tooling/portals.
// Hand-authored because the routes are hand-written Hono handlers (not zod-openapi). Paths
// mirror what's deployed today; the /v1 path-prefix move is a separate coordinated change
// (the live dashboard calls these paths). Security = Bearer: a Clerk session OR an agent token.

const bearer = [{ bearerAuth: [] as string[] }];
const json = (schema: unknown) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Tenant (store) id',
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Ratio Control-Plane API',
    version: '1.0.0',
    description:
      'Authenticated API the admin portal + AI agent both drive (ADR-014). Auth: Clerk session or ADR-007 agent token; per-store authorization via memberships (deny-by-default).',
  },
  servers: [
    {
      url: '/',
      description: 'Control-plane root (paths are unversioned today; /v1 migration pending)',
    },
  ],
  security: bearer,
  paths: {
    '/me': {
      get: {
        operationId: 'getMe',
        summary: 'The caller identity',
        responses: { '200': { description: 'ok', content: json(ref('Identity')) } },
      },
    },
    '/stores': {
      get: {
        operationId: 'listStores',
        summary: 'Stores the caller may manage',
        responses: {
          '200': {
            description: 'ok',
            content: json({
              type: 'object',
              properties: { stores: { type: 'array', items: ref('StoreSummary') } },
              required: ['stores'],
            }),
          },
        },
      },
      post: {
        operationId: 'createStore',
        summary: 'Onboard a store (caller becomes owner)',
        requestBody: { required: true, content: json(ref('StoreCreate')) },
        responses: { '201': { description: 'created', content: json(ref('StoreCreated')) } },
      },
    },
    '/stores/{id}': {
      parameters: [idParam],
      get: {
        operationId: 'getStore',
        summary: 'Read a store',
        responses: {
          '200': { description: 'ok', content: json(ref('Store')) },
          '403': { description: 'forbidden' },
          '404': { description: 'not found' },
        },
      },
      delete: {
        operationId: 'deleteStore',
        summary: 'Provable hard-delete',
        responses: { '200': { description: 'delete proof', content: json(ref('DeleteProof')) } },
      },
    },
    '/stores/{id}/page': {
      parameters: [idParam],
      get: {
        operationId: 'getPage',
        summary: 'Read one page by path',
        parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'ok', content: json(ref('Page')) },
          '404': { description: 'not found' },
        },
      },
      put: {
        operationId: 'putPage',
        summary: 'Create or replace a page (edits the live store)',
        requestBody: { required: true, content: json(ref('PageInput')) },
        responses: {
          '200': { description: 'ok', content: json(ref('Page')) },
          '400': { description: 'invalid' },
        },
      },
    },
    '/stores/{id}/domains': {
      parameters: [idParam],
      get: {
        operationId: 'listDomains',
        summary: 'Domains mapped to the store + status',
        responses: {
          '200': {
            description: 'ok',
            content: json({
              type: 'object',
              properties: { domains: { type: 'array', items: ref('DomainStatus') } },
              required: ['domains'],
            }),
          },
        },
      },
      post: {
        operationId: 'connectDomain',
        summary: 'Connect a custom domain; returns DNS records to add',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            properties: { host: { type: 'string' } },
            required: ['host'],
          }),
        },
        responses: {
          '201': { description: 'connected', content: json(ref('DomainConnection')) },
          '400': { description: 'invalid host' },
        },
      },
    },
    '/stores/{id}/audit': {
      parameters: [idParam],
      get: {
        operationId: 'listAudit',
        summary: 'Recent control-plane changes for the store (newest first)',
        responses: {
          '200': {
            description: 'ok',
            content: json({
              type: 'object',
              properties: { entries: { type: 'array', items: ref('AuditEntry') } },
              required: ['entries'],
            }),
          },
        },
      },
    },
    '/stores/{id}/agent-tokens': {
      parameters: [idParam],
      post: {
        operationId: 'mintAgentToken',
        summary: 'Mint a short-lived agent token scoped to this store (ADR-007)',
        responses: { '201': { description: 'minted', content: json(ref('AgentToken')) } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Clerk session JWT or a rat_ agent token',
      },
    },
    schemas: {
      Identity: {
        type: 'object',
        properties: { userId: { type: 'string' }, isPlatformAdmin: { type: 'boolean' } },
        required: ['userId', 'isPlatformAdmin'],
      },
      StoreSummary: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string' },
          host: { type: ['string', 'null'] },
          hosts: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'name', 'role', 'hosts'],
      },
      StoreCreate: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          host: { type: 'string' },
          color: { type: 'string' },
        },
        required: ['id', 'name', 'host'],
      },
      StoreCreated: {
        type: 'object',
        properties: { id: { type: 'string' }, url: { type: 'string' } },
        required: ['id', 'url'],
      },
      Store: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          theme: { type: 'object', additionalProperties: true },
        },
        required: ['id', 'name'],
      },
      PageInput: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'must start with /' },
          pageType: { type: 'string' },
          pageConfig: { type: 'object', additionalProperties: true },
        },
        required: ['path', 'pageConfig'],
      },
      Page: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          pageType: { type: 'string' },
          pageConfig: { type: 'object', additionalProperties: true },
        },
        required: ['path', 'pageConfig'],
      },
      DomainStatus: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          sslStatus: { type: 'string' },
        },
        required: ['host', 'kind', 'status'],
      },
      DomainConnection: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          configured: { type: 'boolean' },
          status: { type: 'string' },
          sslStatus: { type: 'string' },
          apex: { type: 'boolean' },
          cnameTarget: { type: 'string' },
          records: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                name: { type: 'string' },
                host: { type: 'string' },
                value: { type: 'string' },
                ttl: { type: 'string' },
                purpose: { type: 'string' },
              },
            },
          },
        },
        required: ['host', 'configured'],
      },
      AgentToken: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          scope: { type: 'array', items: { type: 'string' } },
          expiresIn: { type: 'integer' },
        },
        required: ['token', 'scope', 'expiresIn'],
      },
      AuditEntry: {
        type: 'object',
        properties: {
          at: { type: 'string' },
          actor: { type: 'string' },
          actorKind: { type: 'string' },
          action: { type: 'string' },
          method: { type: 'string' },
          status: { type: 'integer' },
        },
        required: ['at', 'actor', 'actorKind', 'action'],
      },
      DeleteProof: {
        type: 'object',
        properties: {
          residual: { type: 'integer' },
          removed: { type: 'object', additionalProperties: true },
        },
        required: ['residual'],
      },
    },
  },
} as const;
