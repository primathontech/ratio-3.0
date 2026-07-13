import type { Context, MiddlewareHandler } from 'hono';
import { verifyToken } from '@clerk/backend';
import { pool } from '../../packages/shared/db';

// ADR-010 admin auth. Split by design:
//  - authN (who is this user) is Clerk's job — we verify its session JWT offline.
//  - authZ (which store may they touch) is OURS — the memberships table, deny-by-default.
// This keeps the data plane free of any auth-vendor dependency and lets us swap the
// provider without touching the tenant model.

export interface Identity {
  userId: string;
}
export type Verifier = (token: string) => Promise<Identity | null>;

type Vars = { Variables: { userId: string } };

// Production verifier. Prefers CLERK_JWT_KEY (PEM) for fully offline verification; falls
// back to CLERK_SECRET_KEY, where @clerk/backend fetches + caches the JWKS itself (the
// standard, lower-setup path). Either one alone is enough to run.
export const clerkVerifier: Verifier = async (token) => {
  const jwtKey = process.env.CLERK_JWT_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!jwtKey && !secretKey) return null;
  try {
    const payload = await verifyToken(token, jwtKey ? { jwtKey } : { secretKey });
    return payload.sub ? { userId: payload.sub } : null;
  } catch {
    return null;
  }
};

// Token from an Authorization: Bearer header (API) or the __session cookie (browser UI).
function extractToken(c: Context): string | null {
  const m = (c.req.header('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  const cm = (c.req.header('cookie') || '').match(/(?:^|;\s*)__session=([^;]+)/);
  return cm ? decodeURIComponent(cm[1]) : null;
}

// Verifies the session and sets c.get('userId'); 401 otherwise. Public paths skip auth.
export function authMiddleware(
  verify: Verifier,
  publicPaths: string[] = ['/health', '/']
): MiddlewareHandler<Vars> {
  return async (c, next) => {
    if (publicPaths.includes(c.req.path)) return next();
    const token = extractToken(c);
    const id = token ? await verify(token) : null;
    if (!id) return c.json({ error: 'unauthorized' }, 401);
    c.set('userId', id.userId);
    return next();
  };
}

export interface Membership {
  role: string;
}

export async function getMembership(userId: string, tenantId: string): Promise<Membership | null> {
  const { rows } = await pool.query<Membership>(
    'SELECT role FROM memberships WHERE clerk_user_id = $1 AND tenant_id = $2',
    [userId, tenantId]
  );
  return rows[0] || null;
}

// Platform super-admins (Ratio staff) — an allowlist of Clerk user IDs in the
// PLATFORM_ADMIN_IDS env (comma-separated). Deny-by-default: empty => nobody. Read lazily
// so it can't be baked in at import time. This is the ONE cross-tenant escape hatch.
export function isPlatformAdmin(userId: string): boolean {
  const ids = (process.env.PLATFORM_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(userId);
}

// Every store (platform-admin view). Role reported as 'admin'.
export async function listAllStores(): Promise<
  { id: string; name: string; role: string; host: string | null }[]
> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    role: string;
    host: string | null;
  }>(
    `SELECT t.id, t.name, 'admin' AS role,
            (SELECT host FROM domains WHERE tenant_id = t.id
              ORDER BY (host LIKE '%.localhost'), host LIMIT 1) AS host
       FROM tenants t
      ORDER BY t.name`
  );
  return rows;
}

// The stores a user may manage (their memberships joined to tenants). Crosses tenant
// boundaries by design — it's the caller's own access list, scoped to their user id.
export async function listStoresForUser(
  userId: string
): Promise<{ id: string; name: string; role: string; host: string | null }[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    role: string;
    host: string | null;
  }>(
    `SELECT t.id, t.name, m.role,
            (SELECT host FROM domains WHERE tenant_id = t.id
              ORDER BY (host LIKE '%.localhost'), host LIMIT 1) AS host
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.clerk_user_id = $1
      ORDER BY t.name`,
    [userId]
  );
  return rows;
}

// Route guard: the authenticated user must have a membership on :id, else 403.
export const requireMembership: MiddlewareHandler<Vars> = async (c, next) => {
  const userId = c.get('userId');
  if (isPlatformAdmin(userId)) return next(); // super-admin: access to every store
  const tenantId = c.req.param('id');
  const m = tenantId ? await getMembership(userId, tenantId) : null;
  if (!m) return c.json({ error: 'forbidden' }, 403);
  return next();
};
