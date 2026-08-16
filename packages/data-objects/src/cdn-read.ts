import type { ObjectStore } from './object-store';

// Reads immutable (content-addressed) objects through a CDN (e.g. CloudFront over the bucket),
// delegating everything else to the wrapped store. Only keys containing `immutableMarker` are served
// from the CDN — those are content-hash keys, so they're never stale and the CDN can cache them forever.
// The mutable draft object and all writes/head/delete always go to the wrapped store. Any CDN
// non-2xx or network error falls back to the wrapped store, so the CDN is a pure accelerator: if it's
// misconfigured or cold, reads still succeed against S3.
export interface CdnReadOptions {
  // Marks immutable content-addressed objects — a key that CONTAINS this segment is served from the
  // CDN. Default matches ThemeStore's `themes/<themeId>/versions/...` layout.
  immutableMarker?: string;
  // Namespace prepended to keys in the bucket — must match the wrapped S3ObjectStore's keyPrefix so
  // the CDN URL points at the same object path.
  keyPrefix?: string;
  // Injectable for tests.
  fetchImpl?: typeof fetch;
}

export class CdnReadObjectStore implements ObjectStore {
  private readonly base: string;
  private readonly immutableMarker: string;
  private readonly keyPrefix: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly inner: ObjectStore,
    cdnBaseUrl: string,
    opts: CdnReadOptions = {}
  ) {
    this.base = cdnBaseUrl.replace(/\/+$/, '');
    this.immutableMarker = opts.immutableMarker ?? '/versions/';
    this.keyPrefix = opts.keyPrefix ?? '';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (key.includes(this.immutableMarker)) {
      const viaCdn = await this.tryCdn(key);
      if (viaCdn !== undefined) return viaCdn;
    }
    return this.inner.get(key);
  }

  // 2xx → bytes; any non-2xx or error → undefined, so the caller falls back to the authoritative store.
  private async tryCdn(key: string): Promise<Uint8Array | undefined> {
    try {
      const res = await this.fetchImpl(`${this.base}/${this.keyPrefix}${key}`);
      if (!res.ok) return undefined;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return undefined;
    }
  }

  put(key: string, body: Uint8Array, opts?: { contentType?: string }): Promise<{ etag: string }> {
    return this.inner.put(key, body, opts);
  }
  head(key: string): Promise<{ etag: string } | null> {
    return this.inner.head(key);
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}
