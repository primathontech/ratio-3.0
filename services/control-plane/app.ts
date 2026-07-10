import { Hono } from 'hono';
import { onboardStore, deleteStore } from '../../packages/provisioning/index';
import { forTenant } from '../../packages/repo/index';

// Ratio CONTROL PLANE (ADR-014): the authenticated API the admin portal + AI agent
// both drive. Wraps provisioning (onboard/delete) + store reads. Data plane (edge +
// origin) is separate and public; this is write-path and must be authed.
// NOTE: token auth is a placeholder — real merchant/agent identity is ADR-010.
export const app = new Hono();

// Auth first: everything except /health needs a bearer token (read lazily = test-friendly).
app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next();
  const expected = process.env.CONTROL_PLANE_TOKEN || 'dev-token';
  if (c.req.header('authorization') !== `Bearer ${expected}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

app.onError((e, c) => c.json({ error: e.message }, 400));

app.get('/health', (c) => c.json({ status: 'ok' }));

// Onboard a store (merchant = data).
app.post('/stores', async (c) => {
  const { id, name, host, color } = (await c.req.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    host?: string;
    color?: string;
  };
  await onboardStore({ id, name, host, color });
  return c.json({ id, url: `https://${host}/` }, 201);
});

// Read a store.
app.get('/stores/:id', async (c) => {
  const tenant = await forTenant(c.req.param('id')).getTenant();
  if (!tenant) return c.json({ error: 'not found' }, 404);
  return c.json({ id: tenant.id, name: tenant.name, theme: tenant.theme });
});

// Provably-complete hard-delete (ADR-010 D-SEC4).
app.delete('/stores/:id', async (c) => {
  const proof = await deleteStore(c.req.param('id'));
  return c.json(proof);
});
