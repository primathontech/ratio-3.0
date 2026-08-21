// Composition root: the ONLY place admin-api reads process.env. Everything downstream (libraries,
// helpers) takes these values as input — no package reads process.env (ADR-0001).
// Required values must be PROVIDED (via apps/admin-api/.env) — a missing one throws loudly at
// startup rather than silently falling back, so misconfiguration is never a mystery to debug.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name} — set it in apps/admin-api/.env`);
  return v;
}

const local = process.env.RATIO_LOCAL === 'true';

// The compiled-bundle object store (BC0), OPTIONAL — mirrors apps/origin/src/config.ts. Set
// BUNDLE_S3_BUCKET to enable the bundle-theme authoring endpoints; unset ⇒ those routes 503 and
// admin-api still boots (no new prod-breaking required env). Credentials are optional — omit them to
// use the AWS default chain (IAM role); pass a custom endpoint + keys for MinIO/LocalStack in dev.
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
  // Boolean toggles — absence legitimately means "off", not a hidden fallback.
  local,
  devInsecureClerk:
    process.env.NODE_ENV !== 'production' && (local || process.env.DEV_INSECURE_CLERK === 'true'),
  insecureTls: process.env.DB_INSECURE_TLS === 'true',
  // Required — no default.
  databaseUrl: required('DATABASE_URL'),
  // Optional — null disables the bundle-theme authoring endpoints.
  bundleStore: bundleStore(),
  // The private origin's base URL. Optional — unset disables the launch pre-warm (the origin can't be
  // reached, so a just-launched store's first request pays the cold bundle-load cost as before).
  originUrl: process.env.ORIGIN_URL,
};
