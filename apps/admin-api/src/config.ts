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

export const config = {
  // Boolean toggles — absence legitimately means "off", not a hidden fallback.
  local,
  devInsecureClerk:
    process.env.NODE_ENV !== 'production' && (local || process.env.DEV_INSECURE_CLERK === 'true'),
  insecureTls: process.env.DB_INSECURE_TLS === 'true',
  // Required — no default.
  databaseUrl: required('DATABASE_URL'),
};
