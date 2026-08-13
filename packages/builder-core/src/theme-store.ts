// The theme store (LLD BC1/BC2): theme file BYTES live as compressed bundles in an ObjectStore (S3),
// never one object per file. The mutable draft is one source bundle; Publish freezes an immutable,
// content-addressed source bundle (for merges / re-editing) plus a compiled bundle (for rendering).
// Publish records the version + flips the store's live pointer (Postgres); loadLiveCompiled is the
// origin's read path. The lean per-file draft index (theme_file) lands with the editor.
import { packBundle, unpackBundle, bundleId, type ThemeFiles } from './bundle';
import { tenantTag } from './tags';
import type { ObjectStore } from '@ratio/data-objects';
import { pool } from '@ratio/data-db';

export interface ThemeRef {
  themeId: string;
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

  // Write the whole editable draft as one source bundle; returns its content hash.
  async saveDraft(ref: ThemeRef, files: ThemeFiles): Promise<{ hash: string }> {
    assertThemeId(ref.themeId);
    await this.objects.put(draftKey(ref.themeId), packBundle(files), { contentType: GZIP });
    return { hash: bundleId(files) };
  }

  // Freeze the current draft into immutable, content-addressed source + compiled bundles in the
  // object store (no DB). The public `publish` builds on this to also record the version + pointer.
  async freezeBundles(ref: ThemeRef, opts: { compile: CompileFn }): Promise<PublishedBundles> {
    const source = await this.readDraft(ref);
    const sourceHash = bundleId(source);
    await this.objects.put(sourceKey(sourceHash), packBundle(source), { contentType: GZIP });

    const compiled = await opts.compile(source);
    const compiledHash = bundleId(compiled);
    await this.objects.put(compiledKey(compiledHash), packBundle(compiled), { contentType: GZIP });

    return { sourceHash, compiledHash };
  }

  // Create a tenant's theme record if it does not exist (onboarding / first edit).
  async ensureTheme(tenantId: string, themeId: string, name = 'Theme'): Promise<void> {
    assertThemeId(themeId);
    await pool.query(
      'INSERT INTO theme (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [themeId, tenantId, name]
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
