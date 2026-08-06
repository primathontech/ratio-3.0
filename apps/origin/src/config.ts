// Composition root: the ONLY place origin reads DB config from process.env. The library
// (@ratio/data-db) reads no env — the app injects it via configureDb (ADR-0001). Required values
// must be PROVIDED (apps/origin/.env) — a missing one throws at startup, never a silent default.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name} — set it in apps/origin/.env`);
  return v;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  insecureTls: process.env.DB_INSECURE_TLS === 'true',
};
