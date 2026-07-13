import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { onboardStore, deleteStore } from '../../packages/provisioning/index';
import { forTenant } from '../../packages/repo/index';
import {
  authMiddleware,
  requireMembership,
  listStoresForUser,
  listAllStores,
  isPlatformAdmin,
  clerkVerifier,
  type Verifier,
} from './auth';

// Ratio CONTROL PLANE (ADR-014): the authenticated API the admin portal + AI agent
// both drive. Data plane (edge + origin) is separate and public; this is the write path.
// Auth is ADR-010: Clerk verifies identity, our memberships table authorizes per store.
// createApp takes the verifier so tests can inject identity without calling Clerk.
type Vars = { Variables: { userId: string } };

export function createApp(verify: Verifier = clerkVerifier) {
  const app = new Hono<Vars>();

  // The admin SPA lives on a different origin (Cloudflare Pages) and calls this API from
  // the browser with a Bearer token, so it needs CORS. Lock to ADMIN_CORS_ORIGIN in prod
  // (comma-separated allowed origins); '*' only as a dev default. Runs before auth so
  // preflight OPTIONS isn't rejected by the 401 gate.
  const origins = (process.env.ADMIN_CORS_ORIGIN || '*').split(',').map((o) => o.trim());
  app.use('*', cors({ origin: origins.length === 1 ? origins[0] : origins }));

  app.use('*', authMiddleware(verify));
  app.onError((e, c) => c.json({ error: e.message }, 400));

  // Public liveness root — the ECS Express gateway health-checks GET / and expects 200.
  app.get('/', (c) => c.json({ service: 'ratio-admin-api', status: 'ok' }));
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Who am I — also surfaces the caller's Clerk id (for PLATFORM_ADMIN_IDS setup).
  app.get('/me', (c) => {
    const userId = c.get('userId');
    return c.json({ userId, isPlatformAdmin: isPlatformAdmin(userId) });
  });

  // The stores the signed-in user may manage (drives the admin portal's home screen).
  // Platform admins see every store; everyone else sees only their memberships.
  app.get('/stores', async (c) => {
    const userId = c.get('userId');
    const stores = isPlatformAdmin(userId)
      ? await listAllStores()
      : await listStoresForUser(userId);
    return c.json({ stores });
  });

  // Create a store. The authenticated caller becomes its owner — the membership is
  // written in the same transaction as the tenant, so a store always has an owner.
  app.post('/stores', async (c) => {
    const { id, name, host, color } = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      host?: string;
      color?: string;
    };
    await onboardStore({ id, name, host, color, ownerUserId: c.get('userId') });
    return c.json({ id, url: `https://${host}/` }, 201);
  });

  // Read a store — caller must have a membership on it.
  app.get('/stores/:id', requireMembership, async (c) => {
    const tenant = await forTenant(c.req.param('id')).getTenant();
    if (!tenant) return c.json({ error: 'not found' }, 404);
    return c.json({ id: tenant.id, name: tenant.name, theme: tenant.theme });
  });

  // Provably-complete hard-delete (ADR-010 D-SEC4) — caller must have a membership.
  app.delete('/stores/:id', requireMembership, async (c) => {
    const proof = await deleteStore(c.req.param('id'));
    return c.json(proof);
  });

  // --- Content CRUD (OFCE-362 slice 2). All membership-gated. The storefront renders
  // whatever page_config lives here, so editing a page changes the live store. ---

  app.get('/stores/:id/pages', requireMembership, async (c) => {
    const pages = await forTenant(c.req.param('id')).listRoutes();
    return c.json({ pages });
  });

  app.get('/stores/:id/page', requireMembership, async (c) => {
    const path = c.req.query('path');
    if (!path) return c.json({ error: 'path query param required' }, 400);
    const route = await forTenant(c.req.param('id')).getRoute(path);
    if (!route) return c.json({ error: 'not found' }, 404);
    return c.json({ path: route.path, pageType: route.page_type, pageConfig: route.page_config });
  });

  app.put('/stores/:id/page', requireMembership, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      path?: string;
      pageType?: string;
      pageConfig?: unknown;
    };
    if (!body.path || !body.path.startsWith('/')) {
      return c.json({ error: 'path is required and must start with /' }, 400);
    }
    if (typeof body.pageConfig !== 'object' || body.pageConfig === null) {
      return c.json({ error: 'pageConfig must be an object' }, 400);
    }
    const pageType = body.pageType || 'page';
    await forTenant(c.req.param('id')).addRoute(body.path, pageType, body.pageConfig);
    return c.json({ path: body.path, pageType, pageConfig: body.pageConfig });
  });

  return app;
}

export const app = createApp();
