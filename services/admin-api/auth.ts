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

// Production verifier: offline JWT verification against the Clerk instance's JWKS
// public key (CLERK_JWT_KEY, PEM). No network call, no shared secret in the hot path.
export const clerkVerifier: Verifier = async (token) => {
  const jwtKey = process.env.CLERK_JWT_KEY;
  if (!jwtKey) return null;
  try {
    const payload = await verifyToken(token, { jwtKey });
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
  publicPaths: string[] = ['/health']
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

// Route guard: the authenticated user must have a membership on :id, else 403.
export const requireMembership: MiddlewareHandler<Vars> = async (c, next) => {
  const tenantId = c.req.param('id');
  const m = tenantId ? await getMembership(c.get('userId'), tenantId) : null;
  if (!m) return c.json({ error: 'forbidden' }, 403);
  return next();
};
