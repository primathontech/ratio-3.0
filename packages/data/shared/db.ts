import { Pool } from 'pg';

// Env is the SERVICE's responsibility: each service loads its own .env via `node --env-file` on its
// run command (see package.json). This shared lib just reads process.env — it never hunts for a
// .env file. Local dev defaults to the docker Postgres (`bun run db:up`).
const connectionString = process.env.DATABASE_URL || 'postgres://poc:poc@localhost:5433/poc';

const isManagedTls = /neon\.tech|sslmode=require/.test(connectionString);

export const pool = new Pool({
  connectionString,
  // Managed Postgres (Neon) requires TLS and MUST verify the server certificate (H-4) —
  // otherwise a network MITM can impersonate the DB carrying every tenant's data. Neon's
  // chain is publicly trusted, so Node's system CA store suffices. DB_INSECURE_TLS=true is
  // an emergency-only escape hatch (see OFCE-407) if a CA surprise appears in staging.
  // Local dev (no managed TLS) needs no SSL.
  ssl: isManagedTls ? { rejectUnauthorized: process.env.DB_INSECURE_TLS !== 'true' } : undefined,
});

// An idle pooled client can emit 'error' (e.g. Neon drops the connection). With no listener
// Node treats it as an unhandled 'error' event and crashes the process; the pool discards
// the bad client on its own, so we only need to observe it (L-3).
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});
