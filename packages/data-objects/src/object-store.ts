// A minimal object store — the storage layer for theme bundles + assets (LLD BC0). It holds
// content-addressed immutable objects (published versions, assets) and one mutable draft object per
// theme; concurrency for the mutable draft is handled by the Postgres file index (revision), so this
// interface stays deliberately small. The theme store composes an ObjectStore; the app injects a
// concrete one — S3 in prod, the same code against S3-compatible MinIO in tests (only the endpoint
// differs).
export interface ObjectStore {
  // Write bytes at `key`; returns the object's ETag. Overwrites if already present.
  put(key: string, body: Uint8Array, opts?: { contentType?: string }): Promise<{ etag: string }>;
  // Read the bytes at `key`, or null if it does not exist.
  get(key: string): Promise<Uint8Array | null>;
  // Whether the object exists (with its ETag), or null if not.
  head(key: string): Promise<{ etag: string } | null>;
  // Remove the object; a no-op (no error) if it is already gone.
  delete(key: string): Promise<void>;
}
