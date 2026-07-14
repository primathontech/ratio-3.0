import type { Context, MiddlewareHandler } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyToken } from '@clerk/backend';
import { pool } from '../../packages/shared/db';

// ADR-010 admin auth. Split by design:
//  - authN (who is this user) is Clerk's job — we verify its session JWT offline.
//  - authZ (which store may they touch) is OURS — the memberships table, deny-by-default.
// This keeps the data plane free of any auth-vendor dependency and lets us swap the
// provider without touching the tenant model.

export interface Identity {
  userId: string;
  // Present only for agent tokens (ADR-007): the tenant ids this token may touch. A '*'
  // element means "all the principal's stores". Absent for human sessions (unrestricted
  // to their memberships).
  scope?: string[];
}
export type Verifier = (token: string) => Promise<Identity | null>;

type Vars = { Variables: { userId: string; scope?: string[] } };

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

// --- ADR-007 agent-scoped tokens ------------------------------------------------------
// The AI agent drives the SAME control-plane API as humans. A token is an HMAC-signed
// claim minted for a PRINCIPAL (the merchant it acts for) + a tenant SCOPE. It resolves,
// through the same Verifier abstraction, to that principal's identity — so authZ still
// runs through the memberships table. The scope can only NARROW that access, never widen
// it (see requireMembership). Signed with AGENT_TOKEN_SECRET; no external dependency.

export interface AgentClaims {
  sub: string; // principal user id the agent acts as
  scope: string[]; // tenant ids the token may touch ('*' = all the principal's stores)
  exp: number; // expiry, unix seconds — agent tokens are short-lived by design
}

function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function mintAgentToken(
  claims: AgentClaims,
  secret = process.env.AGENT_TOKEN_SECRET
): string {
  if (!secret) throw new Error('AGENT_TOKEN_SECRET is not set');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `rat_${body}.${signBody(body, secret)}`;
}

export function verifyAgentToken(
  token: string,
  secret = process.env.AGENT_TOKEN_SECRET,
  now: number = Date.now()
): AgentClaims | null {
  if (!secret || !token.startsWith('rat_')) return null;
  const [body, sig] = token.slice(4).split('.');
  if (!body || !sig) return null;
  const expected = signBody(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as AgentClaims;
    if (!claims.sub || !Array.isArray(claims.scope) || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}

// Verifier variant for agent tokens; ignores anything that isn't one of ours (returns
// null) so it composes cleanly ahead of the Clerk verifier.
export const agentVerifier: Verifier = async (token) => {
  const claims = verifyAgentToken(token);
  return claims ? { userId: claims.sub, scope: claims.scope } : null;
};

// Try each verifier in order; first identity wins. Lets one API accept both human Clerk
// sessions and agent tokens on the same surface.
export function composeVerifiers(...verifiers: Verifier[]): Verifier {
  return async (token) => {
    for (const v of verifiers) {
      const id = await v(token);
      if (id) return id;
    }
    return null;
  };
}

// Token from an Authorization: Bearer header (API) or the __session cookie (browser UI).
function extractToken(c: Context): string | null {
  const m = (c.req.header('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  const cm = (c.req.header('cookie') || '').match(/(?:^|;\s*)__session=([^;]+)/);
  return cm ? decodeURIComponent(cm[1]) : null;
}

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF (I-1): the API also accepts auth via the __session cookie, which a browser attaches on
// cross-site requests. So a state-changing request relying on that ambient cookie (rather than
// an explicit Authorization: Bearer header, which browsers never attach cross-site) must prove
// same-origin via the Origin header against the CORS allowlist. Bearer/API clients and safe
// methods are exempt; a '*' allowlist (dev only) disables the check.
export function csrfGuard(allowedOrigins: string[]): MiddlewareHandler<Vars> {
  const allowAll = allowedOrigins.includes('*');
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    if (allowAll || CSRF_SAFE_METHODS.has(c.req.method)) return next();
    if (/^Bearer\s+/i.test(c.req.header('authorization') || '')) return next();
    const origin = c.req.header('origin');
    if (!origin || !allowed.has(origin)) {
      return c.json({ error: 'cross-site request blocked' }, 403);
    }
    return next();
  };
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
    if (id.scope) c.set('scope', id.scope);
    return next();
  };
}

// Routes that create a store or run the assistant have no :id for requireMembership to
// bind an agent token's scope against. A narrowing scope (present, not including '*') is
// meaningless here and must be rejected — otherwise a "this store only" key could create
// or overwrite arbitrary stores, or escalate to a full-access assistant. Human sessions
// (no scope) and '*'-scoped tokens pass. Global granted∩role∩tenant is Phase 2 (OFCE-402).
export const denyNarrowedScope: MiddlewareHandler<Vars> = async (c, next) => {
  const scope = c.get('scope');
  if (scope && !scope.includes('*')) return c.json({ error: 'out of scope' }, 403);
  return next();
};

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

export interface StoreRow {
  id: string;
  name: string;
  role: string;
  host: string | null; // primary (real domains before .localhost)
  hosts: string[]; // every domain mapped to the store
}

// Domain columns shared by both listings: a primary host + the full list. Real domains
// sort before *.localhost dev domains.
const DOMAIN_COLS = `
  (SELECT host FROM domains WHERE tenant_id = t.id
    ORDER BY (host LIKE '%.localhost'), host LIMIT 1) AS host,
  COALESCE((SELECT array_agg(host ORDER BY (host LIKE '%.localhost'), host)
              FROM domains WHERE tenant_id = t.id), ARRAY[]::text[]) AS hosts`;

// Every store (platform-admin view). Role reported as 'admin'.
export async function listAllStores(): Promise<StoreRow[]> {
  const { rows } = await pool.query<StoreRow>(
    `SELECT t.id, t.name, 'admin' AS role, ${DOMAIN_COLS}
       FROM tenants t
      ORDER BY t.name`
  );
  return rows;
}

// The stores a user may manage (their memberships joined to tenants). Crosses tenant
// boundaries by design — it's the caller's own access list, scoped to their user id.
export async function listStoresForUser(userId: string): Promise<StoreRow[]> {
  const { rows } = await pool.query<StoreRow>(
    `SELECT t.id, t.name, m.role, ${DOMAIN_COLS}
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.clerk_user_id = $1
      ORDER BY t.name`,
    [userId]
  );
  return rows;
}

// Route guard factory: the authenticated user must have a membership on :id (else 403), and
// — when one or more allowed roles are given — that membership's role must be among them
// (M-4). Destructive/privileged verbs (delete, token-mint, domain writes) require 'owner';
// reads and page edits accept any member. Enforcing role now (before member-invite ships)
// keeps a future editor/viewer from inheriting owner-only powers.
export function requireRole(...allowed: string[]): MiddlewareHandler<Vars> {
  return async (c, next) => {
    const userId = c.get('userId');
    const tenantId = c.req.param('id');
    // Agent tokens (ADR-007) carry a tenant scope that only NARROWS access — checked before
    // the platform-admin bypass so a scoped token can't reach beyond its list even if minted
    // for staff. A '*' element means all the principal's stores.
    const scope = c.get('scope');
    if (scope && !scope.includes('*') && (!tenantId || !scope.includes(tenantId))) {
      return c.json({ error: 'out of scope' }, 403);
    }
    if (isPlatformAdmin(userId)) return next(); // super-admin: access to every store
    const m = tenantId ? await getMembership(userId, tenantId) : null;
    if (!m) return c.json({ error: 'forbidden' }, 403);
    if (allowed.length > 0 && !allowed.includes(m.role)) {
      return c.json({ error: 'insufficient role for this action' }, 403);
    }
    return next();
  };
}

// Any member (no role restriction) — reads + page edits.
export const requireMembership: MiddlewareHandler<Vars> = requireRole();
