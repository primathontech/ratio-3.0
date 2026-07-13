import { Hono } from 'hono';
import { onboardStore, deleteStore } from '../../packages/provisioning/index';
import { forTenant } from '../../packages/repo/index';
import { authMiddleware, requireMembership, clerkVerifier, type Verifier } from './auth';

// Ratio CONTROL PLANE (ADR-014): the authenticated API the admin portal + AI agent
// both drive. Data plane (edge + origin) is separate and public; this is the write path.
// Auth is ADR-010: Clerk verifies identity, our memberships table authorizes per store.
// createApp takes the verifier so tests can inject identity without calling Clerk.
type Vars = { Variables: { userId: string } };

export function createApp(verify: Verifier = clerkVerifier) {
  const app = new Hono<Vars>();

  app.use('*', authMiddleware(verify));
  app.onError((e, c) => c.json({ error: e.message }, 400));

  app.get('/health', (c) => c.json({ status: 'ok' }));

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

  return app;
}

export const app = createApp();
