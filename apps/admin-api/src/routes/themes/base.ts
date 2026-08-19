import type { Hono, MiddlewareHandler } from 'hono';
import { planBaseRebase, applyBaseRebase, tenantTag } from '@ratio/builder-core';
import { isPlatformAdmin, denyNarrowedScope } from '../../middleware/auth';
import { MAX_APPLY_TARGETS } from '../../constants';
import type { RouteDeps, Vars } from '../deps';

// Base-theme propagation (OFCE-633 Phase 2): the platform-admin surface over the builder-core
// base-propagation service. Improving the shared base theme is a code + deploy step (it cuts a new
// library-default version); these routes then let an operator SEE which stores are behind and pull the
// improvement into them via the tested rebase — previewed and staged (canary → all), never automatic.
//
// Cross-tenant + destructive to many live storefronts at once, so every route is gated exactly like
// /admin/users: denyNarrowedScope (no scope-narrowed agent token) + an isPlatformAdmin check (the one
// cross-tenant escape hatch). The mutating apply is recorded by auditMiddleware as a single platform
// action (tenant null); the per-store detail is the response body.
export function registerBaseThemeRoutes(app: Hono<Vars>, deps: RouteDeps) {
  const { themes, identityCompile, bundle503, purgeEdgeTags } = deps;

  const platformAdminOnly: MiddlewareHandler<Vars> = async (c, next) => {
    if (!isPlatformAdmin(c.get('userId'))) return c.json({ error: 'forbidden' }, 403);
    return next();
  };

  // Base status: the current base version and how many stores are behind it. `baseThemeId` defaults to
  // the canonical library base; it can name a specific base library (forward-compatible with more than
  // one). Tolerant of a not-yet-provisioned base (no published version) — reports zeros, not a 500.
  app.get('/admin/base-theme', denyNarrowedScope, platformAdminOnly, async (c) => {
    if (!themes) return bundle503(c);
    const baseThemeId = c.req.query('baseThemeId') || undefined;
    try {
      const plan = await planBaseRebase(themes, { baseThemeId });
      return c.json({
        baseThemeId: plan.baseThemeId,
        latestVersion: plan.latestVersion,
        storesBehind: plan.targets.length,
      });
    } catch (e) {
      if (e instanceof Error && /no published version|unknown base theme/.test(e.message))
        return c.json({ baseThemeId: null, latestVersion: null, storesBehind: 0 });
      throw e;
    }
  });

  // Dry-run: the full plan (each store's from→to, isLive, overrideCount, shadowedFiles, blocker). No
  // writes. `toVersion` pins the target base version (defaults to the latest published base);
  // `baseThemeId` names the base library (defaults to the canonical one). A bad baseThemeId / an
  // unpublished base is a caller input error → 400 (unlike the GET dashboard, which reports it as zeros).
  app.post(
    '/admin/base-theme/propagate/preview',
    denyNarrowedScope,
    platformAdminOnly,
    async (c) => {
      if (!themes) return bundle503(c);
      const body = (await c.req.json().catch(() => ({}))) as {
        toVersion?: number;
        baseThemeId?: string;
      };
      try {
        const plan = await planBaseRebase(themes, {
          baseThemeId: body.baseThemeId,
          toVersion: body.toVersion,
        });
        return c.json(plan);
      } catch (e) {
        if (e instanceof Error && /no published version|unknown base theme/.test(e.message))
          return c.json({ error: e.message }, 400);
        throw e;
      }
    }
  );

  // Apply the rebase to a SUPPLIED store set — a canary subset first, then the rest. The caller passes
  // the exact targets it previewed (never "all stores" implicitly), so a staged rollout is explicit.
  // Self-idempotent in the service: a target already current is skipped. Returns per-store outcomes.
  app.post('/admin/base-theme/propagate/apply', denyNarrowedScope, platformAdminOnly, async (c) => {
    if (!themes) return bundle503(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      targets?: { tenantId: string; themeId: string }[];
      toVersion?: number;
    };
    if (!Array.isArray(body.targets) || body.targets.length === 0)
      return c.json(
        { error: 'targets (a non-empty array of {tenantId, themeId}) is required' },
        400
      );
    if (body.targets.length > MAX_APPLY_TARGETS)
      return c.json(
        { error: `too many targets (max ${MAX_APPLY_TARGETS} per request — batch the rollout)` },
        400
      );
    if (
      !body.targets.every(
        (t) => t && typeof t.tenantId === 'string' && typeof t.themeId === 'string'
      )
    )
      return c.json({ error: 'each target needs a string tenantId and themeId' }, 400);

    const outcomes = await applyBaseRebase(themes, body.targets, {
      compile: identityCompile,
      toVersion: body.toVersion,
      by: c.get('userId'),
      // Flush the tenant-tag purge the rebase enqueued in its txn, exactly like the publish route. Prod
      // (Cloudflare) still leans on the durable page_purge_outbox row (tag purge is Enterprise-only) —
      // same contract as every other theme mutation.
      onApplied: (tenantId) => purgeEdgeTags([tenantTag(tenantId)]),
    });
    // A rebase that committed but whose edge purge failed is non-fatal (the store serves stale until the
    // outbox drains) — surface it so an operator can re-flush, matching admin-api's console convention.
    for (const o of outcomes)
      if (o.purgeError)
        console.error('[admin-api] base-rebase purge failed for', o.tenantId, o.purgeError);
    return c.json({ outcomes });
  });
}
