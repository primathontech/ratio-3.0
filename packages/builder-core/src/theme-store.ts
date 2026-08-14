// The theme store (LLD BC1/BC2): theme file BYTES live as compressed bundles in an ObjectStore (S3),
// never one object per file. The mutable draft is one source bundle; Publish freezes an immutable,
// content-addressed source bundle (for merges / re-editing) plus a compiled bundle (for rendering).
// Publish records the version + flips the store's live pointer (Postgres); loadLiveCompiled is the
// origin's read path. The lean per-file draft index (theme_file) lands with the editor.
import { packBundle, unpackBundle, bundleId, type ThemeFiles } from './bundle';
import { composeTheme, diffFromBase } from './theme-compose';
import { tenantTag } from './tags';
import type { ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';

export interface ThemeRef {
  themeId: string;
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
const draftKey = (themeId: string) => `themes/${themeId}/draft/source.gz`;
const sourceKey = (hash: string) => `versions/source/${hash}.gz`;
const compiledKey = (hash: string) => `versions/compiled/${hash}.gz`;

// themeId is interpolated into S3 keys, so it must be a plain slug — reject anything with path
// separators or traversal before it can escape a theme's namespace in the shared bucket.
const THEME_ID_RE = /^[A-Za-z0-9_-]+$/;
function assertThemeId(themeId: string): void {
  if (!THEME_ID_RE.test(themeId)) throw new Error(`invalid theme id: '${themeId}'`);
}

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
    const blob = await this.objects.get(draftKey(ref.themeId));
    return blob ? unpackBundle(Buffer.from(blob)) : {};
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
      await this.objects.put(draftKey(ref.themeId), packBundle(files), { contentType: GZIP });
      return { hash };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize concurrent saves of this theme on its row; the S3 read+write happen inside the lock,
      // so the re-read sees any earlier committed save.
      const locked = await client.query('SELECT 1 FROM theme WHERE id = $1 FOR UPDATE', [
        ref.themeId,
      ]);
      if (locked.rowCount === 0) throw new Error(`unknown theme '${ref.themeId}'`);
      const current = bundleId(await this.readDraft(ref));
      if (current !== opts.expectedRevision)
        throw new DraftConflict(opts.expectedRevision, current);
      await this.objects.put(draftKey(ref.themeId), packBundle(files), { contentType: GZIP });
      await client.query('COMMIT');
      return { hash };
    } catch (e) {
      await client.query('ROLLBACK');
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

  // Freeze the current draft into immutable, content-addressed source + compiled bundles. The draft
  // is the theme's OVERRIDES (its changed files): the SOURCE bundle is those overrides (small, for
  // merges), and the COMPILED bundle is compile(base ⊕ overrides) — the full render-ready theme the
  // origin loads. The base is read from the theme's (base_theme_id, base_version); a root theme (no
  // base) composes over an empty base, so its overrides ARE its whole theme (backward-compatible).
  async freezeBundles(ref: ThemeRef, opts: { compile: CompileFn }): Promise<PublishedBundles> {
    const overrides = await this.readDraft(ref);
    const sourceHash = bundleId(overrides);
    await this.objects.put(sourceKey(sourceHash), packBundle(overrides), { contentType: GZIP });

    const composed = composeTheme(await this.loadBaseSource(ref.themeId), overrides);
    const compiled = await opts.compile(composed);
    const compiledHash = bundleId(compiled);
    await this.objects.put(compiledKey(compiledHash), packBundle(compiled), { contentType: GZIP });

    return { sourceHash, compiledHash };
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
    const v = await pool.query<{ source_hash: string; base_theme_id: string | null }>(
      `SELECT tbv.source_hash, t.base_theme_id
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
    return (await this.loadSource(row.source_hash)) ?? {};
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
      const next = await client.query<{ v: string }>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM theme_bundle_version WHERE theme_id = $1',
        [ref.themeId]
      );
      const version = Number(next.rows[0].v);
      await client.query(
        `INSERT INTO theme_bundle_version (theme_id, version, source_hash, compiled_hash, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [ref.themeId, version, sourceHash, compiledHash, opts.by ?? null]
      );
      if (makeLive) {
        const ptr = await client.query(
          'UPDATE tenants SET live_theme_id = $2, live_theme_version = $3 WHERE id = $1',
          [tenantId, ref.themeId, version]
        );
        if (ptr.rowCount === 0) throw new Error(`unknown tenant '${tenantId}'`);
        // What the store serves changed → enqueue a durable purge of the tenant tag in the SAME
        // transaction (D2), so the edge drops every cached page of this store. Same outbox +
        // drainPurges() worker as the legacy page store; a lost purge can't strand a stale page.
        await client.query('INSERT INTO page_purge_outbox (tenant_id, tags) VALUES ($1, $2)', [
          tenantId,
          [tenantTag(tenantId)],
        ]);
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
    const { rows } = await pool.query<{ compiled_hash: string }>(
      `SELECT bv.compiled_hash
         FROM tenants t
         JOIN theme_bundle_version bv
           ON bv.theme_id = t.live_theme_id AND bv.version = t.live_theme_version
        WHERE t.id = $1`,
      [tenantId]
    );
    const hash = rows[0]?.compiled_hash;
    return hash ? this.loadCompiled(hash) : null;
  }

  // Load a compiled bundle by its content hash (what the origin renders), or null if absent. Cached
  // in the per-instance LRU — the hash is a content address, so a hit is always current. Frozen
  // before caching: the value is shared across requests, so an accidental mutation must throw rather
  // than silently corrupt the cached (and hash-addressed) bundle. Render is read-only; a path that
  // needs to edit a compiled tree must clone it.
  async loadCompiled(compiledHash: string): Promise<ThemeFiles | null> {
    const cached = this.compiledCache.get(compiledHash);
    if (cached) return cached;
    const blob = await this.objects.get(compiledKey(compiledHash));
    if (!blob) return null;
    const files = unpackBundle(Buffer.from(blob));
    Object.freeze(files);
    this.compiledCache.set(compiledHash, files);
    return files;
  }

  // Load a source bundle by its content hash (for merges / re-editing an old version), or null.
  async loadSource(sourceHash: string): Promise<ThemeFiles | null> {
    const blob = await this.objects.get(sourceKey(sourceHash));
    return blob ? unpackBundle(Buffer.from(blob)) : null;
  }
}
