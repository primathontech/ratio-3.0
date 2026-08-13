// Composition root: the ONLY place origin reads DB config from process.env. The library
// (@ratio/data-db) reads no env — the app injects it via configureDb (ADR-0001). Required values
// must be PROVIDED (apps/origin/.env) — a missing one throws at startup, never a silent default.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name} — set it in apps/origin/.env`);
  return v;
}

// The compiled-bundle object store (BC0), OPTIONAL. Set BUNDLE_S3_BUCKET to enable bundle-theme
// rendering; unset ⇒ the origin serves only the legacy page store (no prod-breaking required env).
// Credentials are optional — omit them to use the AWS default chain (IAM role); pass a custom
// endpoint + keys for MinIO/LocalStack in dev.
function bundleStore() {
  const bucket = process.env.BUNDLE_S3_BUCKET;
  if (!bucket) return null;
  const accessKeyId = process.env.BUNDLE_S3_KEY;
  const secretAccessKey = process.env.BUNDLE_S3_SECRET;
  return {
    bucket,
    region: process.env.BUNDLE_S3_REGION,
    endpoint: process.env.BUNDLE_S3_ENDPOINT,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  };
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  insecureTls: process.env.DB_INSECURE_TLS === 'true',
  bundleStore: bundleStore(),
};
