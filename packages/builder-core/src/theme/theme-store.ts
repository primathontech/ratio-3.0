/* eslint-disable max-lines -- ThemeStore is one cohesive domain class (draft/publish/rollback/rebase/
   assets/load/multi-theme); splitting it across files would fragment that cohesion without a partial-
   class idiom. The documented exception to the max-lines guardrail — reviewed + kept whole by decision. */
// The theme store (LLD BC1/BC2): theme file BYTES live as compressed bundles in an ObjectStore (S3),
// never one object per file. The mutable draft is one source bundle; Publish freezes an immutable,
// content-addressed source bundle (for merges / re-editing) plus a compiled bundle (for rendering).
// Publish records the version + flips the store's live pointer (Postgres); loadLiveCompiled is the
// origin's read path. The lean per-file draft index (theme_file) lands with the editor.
import { packBundle, unpackBundle, bundleId, type ThemeFiles } from './bundle';
import {
  assetHash,
  isAssetHash,
  readAssetManifest,
  writeAssetManifest,
  type AssetEntry,
} from './assets';
import { composeTheme, diffFromBase } from './theme-compose';
import { layoutOwnsDocument } from './theme-render';
import { tenantTag } from '../tags';
import type { ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';

export interface ThemeRef {
  themeId: string;
  tenantId: string;
}

// A store's theme as the multi-theme picker sees it: its identity, whether it's the tenant's live
// theme (and at which version), and the highest version it has ever published.
export interface ThemeSummary {
  id: string;
  name: string;
  isLive: boolean;
  liveVersion: number | null; // the tenant's live version IF this theme is live, else null
  latestVersion: number | null; // MAX(theme_bundle_version.version) for this theme, or null
  createdAt: string;
}

// Raised when a draft save's expected revision no longer matches the stored draft — a concurrent
// editor saved first (BC1 optimistic concurrency). Callers map it to HTTP 409. Revisions are content
// hashes of the stored overrides bundle.
export class DraftConflict extends Error {
  constructor(
    public expected: string,
    public actual: string
  ) {
    super(
      `draft was saved concurrently (expected ${expected.slice(0, 12)}, now ${actual.slice(0, 12)})`
    );
    this.name = 'DraftConflict';
  }
}

// Compile a source tree into the render-ready tree (flatten base+overrides, precompile templates,
// resolve asset URLs). Injected so the store stays independent of the Liquid engine — the app wires
// the real compiler; tests can pass a trivial one.
export type CompileFn = (source: ThemeFiles) => ThemeFiles | Promise<ThemeFiles>;

export interface PublishedBundles {
  sourceHash: string; // content address of the frozen source bundle
  compiledHash: string; // content address of the compiled (render-ready) bundle
}

export type PublishResult = PublishedBundles & { version: number };

const GZIP = 'application/gzip';

// tenantId + themeId are interpolated into object keys, so both must be plain slugs — reject path
// separators / traversal before they can escape a store's namespace in the shared bucket.
const KEY_PART_RE = /^[A-Za-z0-9_-]+$/;
function assertKeyPart(value: string, kind: string): void {
  if (!KEY_PART_RE.test(value)) throw new Error(`invalid ${kind}: '${value}'`);
}
const assertThemeId = (themeId: string): void => assertKeyPart(themeId, 'theme id');

// Every object a store owns lives under stores/<tenantId>/… — one prefix per store (clean isolation +
// prefix-delete), with room for other asset types alongside themes/ later (assets/, exports/, …). The
// shared base library is just tenant '_library'. Published artifacts are content-hash keyed under
// published/ (immutable ⇒ CDN-cacheable forever); the draft is the one mutable object.
const themeBase = (tenantId: string, themeId: string) => {
  assertKeyPart(tenantId, 'tenant id');
  assertKeyPart(themeId, 'theme id');
  return `stores/${tenantId}/themes/${themeId}`;
};
const draftKey = (tenantId: string, themeId: string) =>
  `${themeBase(tenantId, themeId)}/draft/source.gz`;
const sourceKey = (tenantId: string, themeId: string, hash: string) =>
  `${themeBase(tenantId, themeId)}/published/source/${hash}.gz`;
const compiledKey = (tenantId: string, themeId: string, hash: string) =>
  `${themeBase(tenantId, themeId)}/published/compiled/${hash}.gz`;
// Raw immutable asset bytes (NOT gzipped — images/fonts/favicons are already compressed) under the
// theme's own prefix, content-hash keyed. Shared across a theme's versions (dedup); a publish freezes
// WHICH hashes it references via the manifest, never the bytes. The hash is validated (it can arrive
// from a merchant-editable manifest) so it can never traverse out of the theme's asset prefix.
const assetObjectKey = (tenantId: string, themeId: string, hash: string) => {
  if (!isAssetHash(hash)) throw new Error(`invalid asset hash '${hash}'`);
  return `${themeBase(tenantId, themeId)}/assets/${hash}`;
};

// A tiny insertion-ordered LRU. Compiled bundles are content-addressed (immutable), so caching them
// by hash is always safe — a repeat load skips the object-store round-trip (LLD BC3). Values are
// treated read-only by callers.
class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
}

export class ThemeStore {
  private readonly compiledCache: Lru<string, ThemeFiles>;
  constructor(
    private readonly objects: ObjectStore,
    opts: { compiledCacheMax?: number } = {}
  ) {
    this.compiledCache = new Lru(opts.compiledCacheMax ?? 32);
  }

  // Read the editable draft's source files (empty theme if never written).
  async readDraft(ref: ThemeRef): Promise<ThemeFiles> {
    assertThemeId(ref.themeId);
    const blob = await this.objects.get(draftKey(ref.tenantId, ref.themeId));
    return blob ? unpackBundle(Buffer.from(blob)) : {};
  }

  // Store a binary theme asset (OFCE-631): content-address the bytes and put them under the theme's
  // asset prefix, returning the manifest entry the caller records in config/assets.json. Idempotent —
  // identical bytes hash to the same key, so a re-upload just rewrites the same object. The bytes live
  // OUTSIDE the text bundle; only the manifest entry (hash + contentType + size) rides the bundle.
  async putAsset(ref: ThemeRef, bytes: Uint8Array, contentType: string): Promise<AssetEntry> {
    assertThemeId(ref.themeId);
    const hash = assetHash(bytes);
    await this.objects.put(assetObjectKey(ref.tenantId, ref.themeId, hash), bytes, { contentType });
    return { hash, contentType, size: bytes.byteLength };
  }

  // Load an asset's raw bytes by content hash (the origin serves them with the manifest's contentType),
  // or null when absent. The hash is validated in assetObjectKey — a malformed hash throws (a loud
  // guard) rather than escaping the theme's prefix; the manifest only ever holds valid hashes.
  async getAsset(ref: ThemeRef, hash: string): Promise<Uint8Array | null> {
    assertThemeId(ref.themeId);
    return this.objects.get(assetObjectKey(ref.tenantId, ref.themeId, hash));
  }

  // Write the whole editable draft as one source bundle; returns its content hash. With
  // `expectedRevision`, a compare-and-swap: the theme row is locked, the current draft re-read, and
  // the write rejected with DraftConflict if it moved since the caller loaded (BC1) — so two editors
  // can't silently clobber. Omit it (base provisioning, non-editor callers) for last-write-wins.
  async saveDraft(
    ref: ThemeRef,
    files: ThemeFiles,
    opts: { expectedRevision?: string } = {}
  ): Promise<{ hash: string }> {
    assertThemeId(ref.themeId);
    const hash = bundleId(files);
    if (opts.expectedRevision === undefined) {
      await this.objects.put(draftKey(ref.tenantId, ref.themeId), packBundle(files), {
        contentType: GZIP,
      });
      return { hash };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize concurrent saves of this theme on its row; the S3 read+write happen inside the lock,
      // so the re-read sees any earlier committed save. lock_timeout bounds how long a contended save
      // waits for the lock (a stuck peer fails its waiters fast instead of piling up connections).
      await client.query("SET LOCAL lock_timeout = '5s'");
      const locked = await client.query('SELECT 1 FROM theme WHERE id = $1 FOR UPDATE', [
        ref.themeId,
      ]);
      if (locked.rowCount === 0) throw new Error(`unknown theme '${ref.themeId}'`);
      const current = bundleId(await this.readDraft(ref));
      if (current !== opts.expectedRevision)
        throw new DraftConflict(opts.expectedRevision, current);
      await this.objects.put(draftKey(ref.tenantId, ref.themeId), packBundle(files), {
        contentType: GZIP,
      });
      // The put is the authoritative, durable write. This transaction changed no Postgres rows — COMMIT
      // only releases the row lock (which also releases when the connection is torn down) — so a COMMIT
      // failure can't lose the draft. Swallow it rather than report a durable save as an error, which
      // would strand the client on a stale revision and spuriously 409 its retry.
      await client.query('COMMIT').catch(() => {});
      return { hash };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // The current draft's revision token — the content hash of the stored overrides (the empty-bundle
  // hash when nothing is saved yet). The editor round-trips it so saveOverrides can reject a stale
  // write; it moves whenever the stored draft's content changes.
  async draftRevision(ref: ThemeRef): Promise<string> {
    assertThemeId(ref.themeId);
    return bundleId(await this.readDraft(ref));
  }

  // Save the theme from the FULL composed tree the editor works with (base ⊕ overrides), storing only
  // the delta from the base — changed/added files + a `_deletes` manifest for base files the merchant
  // removed. This keeps untouched files tracking base updates instead of shadowing the base with a
  // full per-store copy. The inverse of readComposed; a root theme (no base) stores the whole tree.
  async saveOverrides(
    ref: ThemeRef,
    full: ThemeFiles,
    opts: { expectedRevision?: string } = {}
  ): Promise<{ hash: string }> {
    const base = await this.loadBaseSource(ref.themeId);
    return this.saveDraft(ref, diffFromBase(base, full), opts);
  }

  // Reset the draft to pure base: store an EMPTY overrides bundle, so readComposed returns the
  // untouched base theme again (drops every customization the merchant made). The inverse of
  // saveOverrides with a full override set. Intentionally UNCONDITIONAL (no expectedRevision): the
  // result "overrides = {}" doesn't depend on the prior draft, so there's nothing to conflict with; a
  // sibling tab that later saves with a stale revision is still caught by saveDraft's own CAS (409).
  async resetDraft(ref: ThemeRef): Promise<{ hash: string }> {
    return this.saveDraft(ref, {});
  }

  // Freeze the current draft into immutable, content-addressed source + compiled bundles. The draft
  // is the theme's OVERRIDES (its changed files): the SOURCE bundle is those overrides (small, for
  // merges), and the COMPILED bundle is compile(base ⊕ overrides) — the full render-ready theme the
  // origin loads. The base is read from the theme's (base_theme_id, base_version); a root theme (no
  // base) composes over an empty base, so its overrides ARE its whole theme (backward-compatible).
  async freezeBundles(ref: ThemeRef, opts: { compile: CompileFn }): Promise<PublishedBundles> {
    const overrides = await this.readDraft(ref);
    const sourceHash = bundleId(overrides);
    await this.objects.put(
      sourceKey(ref.tenantId, ref.themeId, sourceHash),
      packBundle(overrides),
      {
        contentType: GZIP,
      }
    );

    const composed = composeTheme(await this.loadBaseSource(ref.themeId), overrides);
    const compiled = await this.promoteBaseCss(ref, await opts.compile(composed));
    const compiledHash = bundleId(compiled);
    await this.objects.put(
      compiledKey(ref.tenantId, ref.themeId, compiledHash),
      packBundle(compiled),
      {
        contentType: GZIP,
      }
    );

    return { sourceHash, compiledHash };
  }

  // OFCE-701: promote the shared base stylesheet (assets/base.css) into the asset manifest as an
  // immutable, content-hashed object so the layout can CDN-link it (<link href="/assets/<hash>">) once,
  // cross-tenant cached, instead of inlining the same bytes on every page of every store. Stores the
  // bytes at the theme's asset key (like any binary asset) and records a text/css manifest entry. The
  // base.css text file stays in the bundle too, so preview/local (which don't hit the manifest) inline
  // it as a fallback. Identical base bytes → identical hash → the edge caches one file for all tenants.
  private async promoteBaseCss(ref: ThemeRef, compiled: ThemeFiles): Promise<ThemeFiles> {
    const css = compiled['assets/base.css'];
    if (typeof css !== 'string' || css === '') return compiled;
    const entry = await this.putAsset(ref, new TextEncoder().encode(css), 'text/css');
    const manifest = readAssetManifest(compiled);
    manifest['assets/base.css'] = entry;
    return writeAssetManifest(compiled, manifest);
  }

  // The base theme's source files (the full base — a base is a root theme, so its frozen source IS
  // the whole theme), or {} if this theme tracks no base. Read from the theme's (base_theme_id,
  // base_version) → that base version's source bundle. (Multi-level bases — a base with its own base —
  // would compose recursively; v1's library bases are roots, so one level suffices.)
  private async loadBaseSource(themeId: string): Promise<ThemeFiles> {
    const { rows } = await pool.query<{
      base_theme_id: string | null;
      base_version: number | null;
    }>('SELECT base_theme_id, base_version FROM theme WHERE id = $1', [themeId]);
    const baseThemeId = rows[0]?.base_theme_id;
    const baseVersion = rows[0]?.base_version;
    if (!baseThemeId || baseVersion == null) return {};
    const v = await pool.query<{
      source_hash: string;
      base_theme_id: string | null;
      tenant_id: string;
    }>(
      `SELECT tbv.source_hash, t.base_theme_id, t.tenant_id
         FROM theme_bundle_version tbv
         JOIN theme t ON t.id = tbv.theme_id
        WHERE tbv.theme_id = $1 AND tbv.version = $2`,
      [baseThemeId, baseVersion]
    );
    const row = v.rows[0];
    if (!row?.source_hash)
      throw new Error(`base '${baseThemeId}'@${baseVersion} has no published version`);
    // A base must be a root: we treat its source bundle as the full theme. If it tracks a base of its
    // own, that bundle is only its overrides — composing it would silently drop files. Fail loud.
    if (row.base_theme_id)
      throw new Error(`base '${baseThemeId}' is not a root theme (tracks '${row.base_theme_id}')`);
    return (await this.loadSource(row.tenant_id, baseThemeId, row.source_hash)) ?? {};
  }

  // The full theme the compiler/preview sees: the base composed with the current draft overrides.
  async readComposed(ref: ThemeRef): Promise<ThemeFiles> {
    return composeTheme(await this.loadBaseSource(ref.themeId), await this.readDraft(ref));
  }

  // Create a tenant's theme record if it does not exist (onboarding / first edit). `base` makes the
  // theme track a library base @version (base ⊕ overrides); omit it for a root/base theme. Create-only:
  // if the theme already exists this is a no-op, so `base` is set once at creation and never re-attached
  // to an existing theme here (base is immutable for the theme's life; a base bump is a separate op).
  async ensureTheme(
    tenantId: string,
    themeId: string,
    name = 'Theme',
    base?: { themeId: string; version: number }
  ): Promise<void> {
    assertThemeId(themeId);
    if (base) assertThemeId(base.themeId);
    await pool.query(
      `INSERT INTO theme (id, tenant_id, name, base_theme_id, base_version) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [themeId, tenantId, name, base?.themeId ?? null, base?.version ?? null]
    );
  }

  // Every theme a tenant owns (the multi-theme picker's list). The `_library` base theme is owned by
  // the system library tenant, so filtering on tenant_id naturally excludes it.
  async listThemes(tenantId: string): Promise<ThemeSummary[]> {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      is_live: boolean;
      live_version: number | null;
      latest_version: number | null;
      created_at: Date;
    }>(
      `SELECT th.id, th.name,
              COALESCE(t.live_theme_id = th.id, false) AS is_live,
              CASE WHEN t.live_theme_id = th.id THEN t.live_theme_version END AS live_version,
              lv.max_version AS latest_version,
              th.created_at
         FROM theme th
         JOIN tenants t ON t.id = th.tenant_id
         LEFT JOIN LATERAL (
           SELECT MAX(version) AS max_version FROM theme_bundle_version WHERE theme_id = th.id
         ) lv ON true
        WHERE th.tenant_id = $1
        ORDER BY th.created_at ASC`,
      [tenantId]
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      isLive: r.is_live,
      liveVersion: r.live_version == null ? null : Number(r.live_version),
      latestVersion: r.latest_version == null ? null : Number(r.latest_version),
      createdAt: r.created_at.toISOString(),
    }));
  }

  // Create a new theme for a tenant. Default: a fresh theme adopting a library `base` @version (or a
  // root theme if omitted). With `duplicateOf`: copy an existing theme of the SAME tenant — its base
  // ref and its current draft overrides — into a new theme (a "duplicate"), so the merchant can branch
  // off a working theme without touching it. `duplicateOf` is verified to belong to `tenantId` first.
  async createTheme(
    tenantId: string,
    themeId: string,
    name: string,
    opts: { base?: { themeId: string; version: number }; duplicateOf?: string } = {}
  ): Promise<void> {
    assertThemeId(themeId);
    if (opts.duplicateOf) {
      const src = await pool.query<{ base_theme_id: string | null; base_version: number | null }>(
        'SELECT base_theme_id, base_version FROM theme WHERE id = $1 AND tenant_id = $2',
        [opts.duplicateOf, tenantId]
      );
      if (src.rowCount === 0)
        throw new Error(`unknown theme '${opts.duplicateOf}' in tenant '${tenantId}'`);
      const row = src.rows[0];
      const srcBase =
        row.base_theme_id && row.base_version != null
          ? { themeId: row.base_theme_id, version: row.base_version }
          : undefined;
      const srcOverrides = await this.readDraft({ themeId: opts.duplicateOf, tenantId });
      await this.ensureTheme(tenantId, themeId, name, srcBase);
      if (Object.keys(srcOverrides).length > 0)
        await this.saveDraft({ themeId, tenantId }, srcOverrides);
      return;
    }
    await this.ensureTheme(tenantId, themeId, name, opts.base);
  }

  // Rename a tenant's theme. Tenant-scoped so a member of store A can't rename store B's theme.
  async renameTheme(tenantId: string, themeId: string, name: string): Promise<void> {
    const r = await pool.query('UPDATE theme SET name = $3 WHERE id = $1 AND tenant_id = $2', [
      themeId,
      tenantId,
      name,
    ]);
    if (r.rowCount === 0) throw new Error(`unknown theme '${themeId}' in tenant '${tenantId}'`);
  }

  // Delete a tenant's theme (its versions + file index cascade). Refuses the live theme — deleting it
  // would strand the tenant's live pointer at a row that no longer exists. Best-effort draft cleanup.
  async deleteTheme(tenantId: string, themeId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the theme row FIRST (same order as publish/setLive) so a concurrent activate can't make
      // this theme live between the live-check and the DELETE — which would strand tenants.live_theme_id
      // at a row that no longer exists. Making a theme live requires this same row lock, so once we
      // hold it the live-check can't go stale.
      const th = await client.query(
        'SELECT 1 FROM theme WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [themeId, tenantId]
      );
      if (th.rowCount === 0) throw new Error(`unknown theme '${themeId}' in tenant '${tenantId}'`);
      const live = await client.query(
        'SELECT 1 FROM tenants WHERE id = $1 AND live_theme_id = $2',
        [tenantId, themeId]
      );
      if (live.rowCount && live.rowCount > 0) throw new Error('cannot delete the live theme');
      await client.query('DELETE FROM theme WHERE id = $1 AND tenant_id = $2', [themeId, tenantId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    await this.objects.delete(draftKey(tenantId, themeId)).catch(() => {});
  }

  // Make one of the tenant's themes live at a given (or its latest) published version — the general
  // activate / switch / rollback primitive. In a txn: verify the theme is the tenant's, resolve the
  // version, repoint tenants.live_theme_*, and enqueue the tenant-tag purge (like publish/rollback) so
  // the edge drops every cached page of this store.
  async setLive(tenantId: string, themeId: string, version?: number): Promise<{ version: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the theme row FIRST (same order as publish/deleteTheme) so activate-vs-delete serialize
      // on one lock: a delete can't remove this theme after we've validated it and before we repoint.
      const t = await client.query(
        'SELECT 1 FROM theme WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [themeId, tenantId]
      );
      if (t.rowCount === 0) throw new Error(`unknown theme '${themeId}' in tenant '${tenantId}'`);
      let v: number;
      if (version != null) {
        const exists = await client.query(
          'SELECT 1 FROM theme_bundle_version WHERE theme_id = $1 AND version = $2',
          [themeId, version]
        );
        if (exists.rowCount === 0)
          throw new Error(`unknown version ${version} for theme '${themeId}'`);
        v = version;
      } else {
        const max = await client.query<{ v: number | null }>(
          'SELECT MAX(version) AS v FROM theme_bundle_version WHERE theme_id = $1',
          [themeId]
        );
        if (max.rows[0].v == null) throw new Error(`theme '${themeId}' has no published version`);
        v = Number(max.rows[0].v);
      }
      await client.query(
        'UPDATE tenants SET live_theme_id = $2, live_theme_version = $3 WHERE id = $1',
        [tenantId, themeId, v]
      );
      // What the store serves changed → durable tenant-tag purge in the same txn (D2).
      await client.query('INSERT INTO page_purge_outbox (tenant_id, tags) VALUES ($1, $2)', [
        tenantId,
        [tenantTag(tenantId)],
      ]);
      await client.query('COMMIT');
      return { version: v };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // A theme's published versions, newest first (the version history panel). Tenant-scoped in SQL (join
  // through theme) so the store layer itself never leaks another tenant's version history — defense in
  // depth, not relying on the route's assertThemeInStore alone.
  async listVersions(
    tenantId: string,
    themeId: string
  ): Promise<{ version: number; createdBy: string | null; createdAt: string }[]> {
    const { rows } = await pool.query<{
      version: number;
      created_by: string | null;
      created_at: Date;
    }>(
      `SELECT bv.version, bv.created_by, bv.created_at
         FROM theme_bundle_version bv
         JOIN theme th ON th.id = bv.theme_id
        WHERE bv.theme_id = $1 AND th.tenant_id = $2
        ORDER BY bv.version DESC`,
      [themeId, tenantId]
    );
    return rows.map((r) => ({
      version: Number(r.version),
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
    }));
  }

  // Publish: freeze the bundles, then (atomically) record a new immutable version and — unless
  // makeLive is false — flip the tenant's live pointer to it. Cutting a version is separable from
  // making it live so a store can keep several themes without every publish hijacking the pointer.
  // The theme is checked BEFORE freezing so a doomed publish writes no orphan bundles to S3; the
  // remaining bundle writes on an aborted transaction are unreferenced (harmless, content-addressed).
  // NOTE: there is no "promote an existing version to live" primitive yet — rollback needs the tenant
  // to already have a live pointer. So a theme first published with makeLive:false becomes live only
  // via a later makeLive:true publish. That primitive lands with multi-theme selection (not needed
  // while a store has one live theme).
  async publish(
    ref: ThemeRef,
    opts: { compile: CompileFn; by?: string; makeLive?: boolean }
  ): Promise<PublishResult> {
    assertThemeId(ref.themeId);
    const makeLive = opts.makeLive ?? true;
    const exists = await pool.query('SELECT 1 FROM theme WHERE id = $1', [ref.themeId]);
    if (exists.rowCount === 0) throw new Error(`unknown theme '${ref.themeId}'`);

    const { sourceHash, compiledHash } = await this.freezeBundles(ref, opts);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the theme row so concurrent publishes serialize on the version bump, and read its tenant.
      const t = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM theme WHERE id = $1 FOR UPDATE',
        [ref.themeId]
      );
      if (t.rowCount === 0) throw new Error(`unknown theme '${ref.themeId}'`);
      const tenantId = t.rows[0].tenant_id;
      // Content-addressed idempotency on the COMPILED (render-ready) output: if what this theme would
      // SERVE is byte-identical to the latest published version, publishing again changed nothing — reuse
      // that version instead of churning v2/v3/… (pressing Publish with no edits). We key on compiled_hash,
      // NOT source_hash: source_hash is only the merchant's OVERRIDES bundle, which is unchanged by a
      // rebase (the base moved) even though the composed output — and thus the served page — did change.
      const latest = await client.query<{ version: string; compiled_hash: string }>(
        'SELECT version, compiled_hash FROM theme_bundle_version WHERE theme_id = $1 ORDER BY version DESC LIMIT 1',
        [ref.themeId]
      );
      const unchanged = latest.rows[0]?.compiled_hash === compiledHash;
      const version = unchanged
        ? Number(latest.rows[0].version)
        : Number(latest.rows[0]?.version ?? 0) + 1;
      if (!unchanged) {
        await client.query(
          `INSERT INTO theme_bundle_version (theme_id, version, source_hash, compiled_hash, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [ref.themeId, version, sourceHash, compiledHash, opts.by ?? null]
        );
      }
      if (makeLive) {
        // Move the live pointer to this (theme, version) — idempotent. Only enqueue a purge when the
        // pointer actually moves (new version, or promoting a different theme/version to live): an
        // unchanged republish that's already live is a true no-op and must not spam the purge outbox.
        const cur = await client.query<{ live: string | null; v: number | null }>(
          'SELECT live_theme_id AS live, live_theme_version AS v FROM tenants WHERE id = $1',
          [tenantId]
        );
        if (cur.rowCount === 0) throw new Error(`unknown tenant '${tenantId}'`);
        const alreadyLive = cur.rows[0].live === ref.themeId && Number(cur.rows[0].v) === version;
        await client.query(
          'UPDATE tenants SET live_theme_id = $2, live_theme_version = $3 WHERE id = $1',
          [tenantId, ref.themeId, version]
        );
        if (!alreadyLive) {
          // What the store serves changed → durable tenant-tag purge in the SAME transaction (D2), so
          // the edge drops every cached page. Same outbox + drainPurges() worker as the legacy page store.
          await client.query('INSERT INTO page_purge_outbox (tenant_id, tags) VALUES ($1, $2)', [
            tenantId,
            [tenantTag(tenantId)],
          ]);
        }
      }
      await client.query('COMMIT');
      return { version, sourceHash, compiledHash };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // Rebase a store's theme onto a newer version of the base it tracks (OFCE-640): point the theme at
  // the target base version (default: the base's latest published version), then republish — so the
  // frozen compiled bundle recomposes base@new ⊕ the store's overrides. Overrides are file-level, so
  // the merchant's edited files win and every file they DIDN'T touch (e.g. layout/theme.liquid) advances
  // to the new base. This is how live stores migrate onto a new base — the full-document layout —
  // without losing customizations. The live pointer moves ONLY if this theme is the store's CURRENT live
  // theme (never hijack a store that activated a different theme). Refuses a root theme (nothing to
  // rebase). A failed publish restores the base pin so a retry isn't skipped as 'already latest'.
  async rebaseToBase(
    tenantId: string,
    themeId: string,
    opts: { compile: CompileFn; toVersion?: number; by?: string }
  ): Promise<{ version: number; baseVersion: number; madeLive: boolean }> {
    assertThemeId(themeId);
    const { rows } = await pool.query<{
      base_theme_id: string | null;
      base_version: number | null;
    }>('SELECT base_theme_id, base_version FROM theme WHERE id = $1 AND tenant_id = $2', [
      themeId,
      tenantId,
    ]);
    const row = rows[0];
    if (!row) throw new Error(`unknown theme '${themeId}' in tenant '${tenantId}'`);
    if (!row.base_theme_id)
      throw new Error(`theme '${themeId}' tracks no base (nothing to rebase)`);
    const prevBaseVersion = row.base_version;

    let target = opts.toVersion;
    if (target == null) {
      const max = await pool.query<{ v: number | null }>(
        'SELECT MAX(version) AS v FROM theme_bundle_version WHERE theme_id = $1',
        [row.base_theme_id]
      );
      if (max.rows[0].v == null)
        throw new Error(`base '${row.base_theme_id}' has no published version`);
      target = Number(max.rows[0].v);
    } else {
      const exists = await pool.query(
        'SELECT 1 FROM theme_bundle_version WHERE theme_id = $1 AND version = $2',
        [row.base_theme_id, target]
      );
      if (exists.rowCount === 0)
        throw new Error(`base '${row.base_theme_id}' has no version ${target}`);
    }

    // Refuse to rebase a theme whose DRAFT has unpublished changes: publish freezes the draft, so
    // rebasing a mid-edit theme would ship the merchant's in-progress work alongside the base bump —
    // a side effect the migration never asked for. A theme is "clean" when its draft overrides hash
    // matches its latest published source. Skip the dirty ones (the bulk script logs + moves on) so
    // they can be rebased by hand once the merchant publishes or resets. (First-publish themes with no
    // version yet are always clean — nothing shipped to diverge from.)
    const latestPub = await pool.query<{ source_hash: string }>(
      'SELECT source_hash FROM theme_bundle_version WHERE theme_id = $1 ORDER BY version DESC LIMIT 1',
      [themeId]
    );
    if (latestPub.rows[0]) {
      const draftHash = bundleId(await this.readDraft({ themeId, tenantId }));
      if (draftHash !== latestPub.rows[0].source_hash)
        throw new Error(
          `theme '${themeId}' has unpublished draft changes; publish or reset the draft before rebasing`
        );
    }

    // The live pointer moves only if this theme is the store's CURRENT live one. This is read outside
    // publish's transaction (a precomputed boolean), so a merchant switching their live theme in the
    // narrow window before publish commits could have it forced back — accepted for a single-operator
    // migration in this pre-launch env; not worth reshaping the shared publish() primitive for.
    const liveRow = await pool.query<{ live: string | null }>(
      'SELECT live_theme_id AS live FROM tenants WHERE id = $1',
      [tenantId]
    );
    const makeLive = liveRow.rows[0]?.live === themeId;

    // Point the theme at the new base version (CAS on the old value: if a concurrent rebase already
    // moved it, abort rather than fight), then republish (freeze base@new ⊕ overrides).
    const bumped = await pool.query(
      'UPDATE theme SET base_version = $3 WHERE id = $1 AND tenant_id = $2 AND base_version = $4',
      [themeId, tenantId, target, prevBaseVersion]
    );
    if (bumped.rowCount === 0)
      throw new Error(`theme '${themeId}' base_version changed concurrently; rerun the rebase`);
    try {
      // Full theme ownership (OFCE-641): if this rebase will move the live pointer, the recomposed
      // theme MUST still own the whole document — the origin serves the live theme's layout with no
      // shell. The route enforces this on publish/activate/rollback; rebaseToBase is a direct primitive
      // caller (the bulk migration script), so it enforces it here too — otherwise a merchant override
      // that broke layout/theme.liquid would be silently republished live (the storefront then 500s).
      // Thrown inside the try so the catch below restores the base pin (the script logs + skips it, and
      // a re-run retries once the merchant fixes their layout) rather than stranding it as 'latest'.
      if (
        makeLive &&
        !layoutOwnsDocument((await this.readComposed({ themeId, tenantId }))['layout/theme.liquid'])
      )
        throw new Error(
          `theme '${themeId}' layout/theme.liquid is not a full HTML document after rebase onto base v${target}; refusing to republish it live under full theme ownership`
        );
      const { version } = await this.publish(
        { themeId, tenantId },
        { compile: opts.compile, makeLive, by: opts.by }
      );
      return { version, baseVersion: target, madeLive: makeLive };
    } catch (e) {
      // Restore the pin so a re-run RETRIES this store instead of reading it as 'already latest' and
      // skipping it forever (base_version is the idempotency marker) — no version ever cut otherwise.
      // CAS on our own target so we never clobber a writer that moved it after our bump.
      await pool
        .query(
          'UPDATE theme SET base_version = $3 WHERE id = $1 AND tenant_id = $2 AND base_version = $4',
          [themeId, tenantId, prevBaseVersion, target]
        )
        .catch(() => {});
      throw e;
    }
  }

  // Roll the tenant back to an earlier published version of its current live theme — an instant
  // pointer move (the immutable bundles are all still in S3). Verifies the version exists.
  async rollback(tenantId: string, version: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<{ live_theme_id: string | null }>(
        'SELECT live_theme_id FROM tenants WHERE id = $1 FOR UPDATE',
        [tenantId]
      );
      if (cur.rowCount === 0) throw new Error(`unknown tenant '${tenantId}'`);
      const themeId = cur.rows[0].live_theme_id;
      if (!themeId) throw new Error(`tenant '${tenantId}' has no published theme`);
      const v = await client.query(
        'SELECT 1 FROM theme_bundle_version WHERE theme_id = $1 AND version = $2',
        [themeId, version]
      );
      if (v.rowCount === 0) throw new Error(`unknown version ${version} for theme '${themeId}'`);
      await client.query('UPDATE tenants SET live_theme_version = $2 WHERE id = $1', [
        tenantId,
        version,
      ]);
      // The live pointer moved → purge the store's cached pages (same durable outbox as publish).
      await client.query('INSERT INTO page_purge_outbox (tenant_id, tags) VALUES ($1, $2)', [
        tenantId,
        [tenantTag(tenantId)],
      ]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // What the origin calls on a cache miss: the compiled bundle of the tenant's live version, or null
  // if the tenant has never published.
  async loadLiveCompiled(tenantId: string): Promise<ThemeFiles | null> {
    const { rows } = await pool.query<{ compiled_hash: string; live_theme_id: string }>(
      `SELECT bv.compiled_hash, t.live_theme_id
         FROM tenants t
         JOIN theme_bundle_version bv
           ON bv.theme_id = t.live_theme_id AND bv.version = t.live_theme_version
        WHERE t.id = $1`,
      [tenantId]
    );
    const row = rows[0];
    return row?.compiled_hash
      ? this.loadCompiled(tenantId, row.live_theme_id, row.compiled_hash)
      : null;
  }

  // Load a compiled bundle by its content hash (what the origin renders), or null if absent. Cached
  // in the per-instance LRU — the hash is a content address, so a hit is always current. Frozen
  // before caching: the value is shared across requests, so an accidental mutation must throw rather
  // than silently corrupt the cached (and hash-addressed) bundle. Render is read-only; a path that
  // needs to edit a compiled tree must clone it.
  async loadCompiled(
    tenantId: string,
    themeId: string,
    compiledHash: string
  ): Promise<ThemeFiles | null> {
    const cached = this.compiledCache.get(compiledHash);
    if (cached) return cached;
    const blob = await this.objects.get(compiledKey(tenantId, themeId, compiledHash));
    if (!blob) return null;
    const files = unpackBundle(Buffer.from(blob));
    Object.freeze(files);
    this.compiledCache.set(compiledHash, files);
    return files;
  }

  // Load a source bundle by its content hash (for merges / re-editing an old version), or null.
  async loadSource(
    tenantId: string,
    themeId: string,
    sourceHash: string
  ): Promise<ThemeFiles | null> {
    const blob = await this.objects.get(sourceKey(tenantId, themeId, sourceHash));
    return blob ? unpackBundle(Buffer.from(blob)) : null;
  }
}
