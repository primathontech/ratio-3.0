// Base propagation (OFCE-633): improve the shared base theme once, then pull it into every store that
// adopted an older version — via the tested `rebaseToBase` primitive, so each store keeps its own edits
// (base ⊕ overrides is file-level; only files the merchant DIDN'T touch advance to the new base). This
// is the reusable core of the old `scripts/rebase-to-latest-base.ts`, split into a PREVIEW (plan) and an
// APPLY so a human can see what will change and stage the rollout (canary → all) before committing.
//
// The service stays free of the edge/HTTP layer: `rebaseToBase → publish` already enqueues the per-tenant
// cache purge in the SAME transaction that moves the live pointer (a durable outbox), so the only thing
// left is to FLUSH that purge to the edge. That flush needs CF creds / the dev edge-sim, which live in
// admin-api — so apply takes an `onApplied(tenantId)` callback the route wires to its purge helpers, and
// the service itself never imports fetch/CF/logger.
import { pool } from '@ratio/data-db';
import { bundleId, type ThemeFiles } from './bundle';
import { composeTheme, DELETES_MANIFEST } from './theme-compose';
import { layoutOwnsDocument } from './theme-render';
import { DEFAULT_BASE_THEME_ID } from './base-library';
import type { ThemeStore, CompileFn } from './theme-store';

// Why a store can't be rebased right now. `dirty-draft`: it has unpublished draft edits, so rebasing
// would ship mid-edit work (rebaseToBase refuses it). `broken-layout`: it's LIVE and its own override
// left layout/theme.liquid a non-full-document, so republishing it live would 500 the storefront under
// full theme ownership (rebaseToBase refuses that too). Both are advisory here — apply is safe either
// way (the primitive throws and we report it); the UI uses them to grey out / warn before applying.
export type RebaseBlock = 'dirty-draft' | 'broken-layout';

// One store's row in the propagation preview.
export interface BaseRebaseTarget {
  tenantId: string;
  themeId: string;
  name: string; // the store's display name
  fromVersion: number; // the base version the theme is pinned to today
  toVersion: number; // the base version it would move to
  isLive: boolean; // is this the tenant's current live theme?
  overrideCount: number; // how many files the merchant has overridden
  // Files the base CHANGED between fromVersion and toVersion that the store ALSO overrode — so the base's
  // new version of those files will NOT reach this store (its override wins). The one thing a file-level
  // rebase does silently; surfaced so an operator can decide whether the store should re-take those files.
  shadowedFiles: string[];
  blocked: RebaseBlock | null;
  error?: string; // preview could not be computed for this store (e.g. an object-store read failed)
}

export interface BaseRebasePlan {
  baseThemeId: string;
  latestVersion: number;
  targets: BaseRebaseTarget[];
}

// One store's result after apply.
export interface BaseRebaseOutcome {
  tenantId: string;
  themeId: string;
  ok: boolean;
  skipped?: boolean; // already at/after the target base version — no version cut, no purge (self-idempotency)
  version?: number; // the new published version, when ok and not skipped
  madeLive?: boolean; // whether this rebase moved the store's live pointer
  error?: string; // the rebase itself failed (dirty/broken/root/concurrent) — see rebaseToBase
  purgeError?: string; // the rebase succeeded but flushing the edge purge failed (page serves stale
  // until the durable outbox row is drained) — non-fatal, surfaced so the operator can re-flush
}

interface PlanOpts {
  baseThemeId?: string;
  toVersion?: number; // pin the target base version; defaults to the base's latest published version
}

// Compute — without changing anything — which stores are behind the base and what rebasing each would do.
export async function planBaseRebase(
  store: ThemeStore,
  opts: PlanOpts = {}
): Promise<BaseRebasePlan> {
  const baseThemeId = opts.baseThemeId ?? DEFAULT_BASE_THEME_ID;
  const baseRow = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM theme WHERE id = $1',
    [baseThemeId]
  );
  const baseTenantId = baseRow.rows[0]?.tenant_id;
  if (!baseTenantId) throw new Error(`unknown base theme '${baseThemeId}'`);

  const latestVersion = opts.toVersion ?? (await maxBaseVersion(baseThemeId));
  if (latestVersion == null) throw new Error(`base '${baseThemeId}' has no published version`);

  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    base_version: number;
    name: string;
    live_theme_id: string | null;
  }>(
    `SELECT th.id, th.tenant_id, th.base_version, ten.name, ten.live_theme_id
       FROM theme th JOIN tenants ten ON ten.id = th.tenant_id
      WHERE th.base_theme_id = $1 AND th.base_version < $2 AND th.tenant_id <> $3
      ORDER BY th.tenant_id`,
    [baseThemeId, latestVersion, baseTenantId]
  );

  const baseTo = await loadBaseVersion(store, baseTenantId, baseThemeId, latestVersion);
  const changedByFrom = new Map<number, Set<string>>(); // base files that moved from vN → target, per vN

  const targets: BaseRebaseTarget[] = [];
  for (const r of rows) {
    const fromVersion = Number(r.base_version);
    const isLive = r.live_theme_id === r.id;
    try {
      let changed = changedByFrom.get(fromVersion);
      if (!changed) {
        const baseFrom = await loadBaseVersion(store, baseTenantId, baseThemeId, fromVersion);
        changed = changedBaseFiles(baseFrom, baseTo);
        changedByFrom.set(fromVersion, changed);
      }
      const overrides = await store.readDraft({ themeId: r.id, tenantId: r.tenant_id });
      const overrideKeys = Object.keys(overrides).filter((k) => k !== DELETES_MANIFEST);
      const shadowedFiles = overrideKeys.filter((k) => changed.has(k)).sort();
      targets.push({
        tenantId: r.tenant_id,
        themeId: r.id,
        name: r.name,
        fromVersion,
        toVersion: latestVersion,
        isLive,
        overrideCount: overrideKeys.length,
        shadowedFiles,
        blocked: await blockReason(store, r.id, r.tenant_id, overrides, baseTo, isLive),
      });
    } catch (e) {
      targets.push({
        tenantId: r.tenant_id,
        themeId: r.id,
        name: r.name,
        fromVersion,
        toVersion: latestVersion,
        isLive,
        overrideCount: 0,
        shadowedFiles: [],
        blocked: null,
        error: e instanceof Error ? e.message : 'preview failed',
      });
    }
  }
  return { baseThemeId, latestVersion, targets };
}

interface ApplyOpts {
  compile: CompileFn;
  toVersion?: number;
  by?: string;
  // Called after each store's rebase succeeds — the route wires this to its edge-purge helpers so the
  // page-purge outbox row the rebase just enqueued is actually flushed. A throw here is captured as a
  // non-fatal `purgeError` on that store's outcome (the rebase already committed; the durable outbox row
  // remains for a later drain), never aborting the run.
  onApplied?: (tenantId: string) => void | Promise<void>;
}

// Rebase each target onto the base version, one store at a time. A single store's failure (dirty draft,
// broken live layout, a concurrent base bump) is captured in its outcome and never aborts the batch — so
// a staged rollout over many stores always runs to completion and reports per-store.
//
// Self-idempotent: a target already at/after the effective base version is SKIPPED (no version cut, no
// purge), so re-applying a STALE target list — e.g. an admin retry of a partially-failed batch that
// reuses the original targets rather than re-planning — never republishes byte-identical versions or
// re-fires purges. (rebaseToBase alone would not guard this: its CAS on base_version trivially succeeds
// when target == current, and it republishes unconditionally.)
export async function applyBaseRebase(
  store: ThemeStore,
  targets: { tenantId: string; themeId: string }[],
  opts: ApplyOpts
): Promise<BaseRebaseOutcome[]> {
  const out: BaseRebaseOutcome[] = [];
  for (const t of targets) {
    try {
      if (await alreadyCurrent(t.themeId, t.tenantId, opts.toVersion)) {
        out.push({
          tenantId: t.tenantId,
          themeId: t.themeId,
          ok: true,
          skipped: true,
          madeLive: false,
        });
        continue;
      }
      const { version, madeLive } = await store.rebaseToBase(t.tenantId, t.themeId, {
        compile: opts.compile,
        toVersion: opts.toVersion,
        by: opts.by,
      });
      let purgeError: string | undefined;
      if (opts.onApplied) {
        try {
          await opts.onApplied(t.tenantId);
        } catch (e) {
          purgeError = e instanceof Error ? e.message : 'purge failed';
        }
      }
      out.push({
        tenantId: t.tenantId,
        themeId: t.themeId,
        ok: true,
        version,
        madeLive,
        purgeError,
      });
    } catch (e) {
      out.push({
        tenantId: t.tenantId,
        themeId: t.themeId,
        ok: false,
        error: e instanceof Error ? e.message : 'rebase failed',
      });
    }
  }
  return out;
}

// Would rebasing this theme be a no-op? True when it already tracks a base and its pin is at/after the
// effective target version (an explicit toVersion, else the base's latest). A root theme (no base) is
// NOT skipped here — it falls through to rebaseToBase, which reports the real "tracks no base" error.
async function alreadyCurrent(
  themeId: string,
  tenantId: string,
  toVersion?: number
): Promise<boolean> {
  const { rows } = await pool.query<{ base_theme_id: string | null; base_version: number | null }>(
    'SELECT base_theme_id, base_version FROM theme WHERE id = $1 AND tenant_id = $2',
    [themeId, tenantId]
  );
  const row = rows[0];
  if (!row?.base_theme_id || row.base_version == null) return false;
  const target = toVersion ?? (await maxBaseVersion(row.base_theme_id));
  return target != null && row.base_version >= target;
}

async function maxBaseVersion(baseThemeId: string): Promise<number | null> {
  const { rows } = await pool.query<{ v: number | null }>(
    'SELECT MAX(version)::int AS v FROM theme_bundle_version WHERE theme_id = $1',
    [baseThemeId]
  );
  return rows[0]?.v ?? null;
}

async function loadBaseVersion(
  store: ThemeStore,
  baseTenantId: string,
  baseThemeId: string,
  version: number
): Promise<ThemeFiles> {
  const { rows } = await pool.query<{ source_hash: string }>(
    'SELECT source_hash FROM theme_bundle_version WHERE theme_id = $1 AND version = $2',
    [baseThemeId, version]
  );
  const hash = rows[0]?.source_hash;
  if (!hash) throw new Error(`base '${baseThemeId}' has no version ${version}`);
  return (await store.loadSource(baseTenantId, baseThemeId, hash)) ?? {};
}

// Files that differ between two base versions (changed, added, or removed) — the ones a rebase would
// carry into a store, unless the store overrode them.
function changedBaseFiles(from: ThemeFiles, to: ThemeFiles): Set<string> {
  const changed = new Set<string>();
  for (const k of new Set([...Object.keys(from), ...Object.keys(to)]))
    if (from[k] !== to[k]) changed.add(k);
  return changed;
}

// Mirror rebaseToBase's two refusals so the preview can flag them BEFORE the operator applies:
// a dirty draft (draft overrides diverge from the last published source), or — for a live theme — a
// composed layout that isn't a full document. dirty-draft takes precedence (rebase checks it first).
async function blockReason(
  store: ThemeStore,
  themeId: string,
  tenantId: string,
  overrides: ThemeFiles,
  baseTo: ThemeFiles,
  isLive: boolean
): Promise<RebaseBlock | null> {
  const latestPub = await pool.query<{ source_hash: string }>(
    'SELECT source_hash FROM theme_bundle_version WHERE theme_id = $1 ORDER BY version DESC LIMIT 1',
    [themeId]
  );
  if (latestPub.rows[0] && bundleId(overrides) !== latestPub.rows[0].source_hash)
    return 'dirty-draft';
  if (isLive && !layoutOwnsDocument(composeTheme(baseTo, overrides)['layout/theme.liquid']))
    return 'broken-layout';
  return null;
}
