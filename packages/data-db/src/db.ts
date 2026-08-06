import { Pool } from 'pg';

export interface DbConfig {
  connectionString: string;
  // Managed Postgres (Neon) requires a VERIFIED TLS cert (H-4). insecureTls is an emergency-only
  // escape hatch (OFCE-407); the app decides it from its own env, never this library.
  insecureTls?: boolean;
}

// This package is `type: module`, but its CommonJS importers (scripts, tests) load it through a
// second module record under tsx — so a plain module-level `let` would give configureDb() and the
// `pool` proxy two DIFFERENT copies, and the injected config would be invisible to the consumer.
// Park the single source of truth on a globalThis slot keyed by a registered Symbol; every copy of
// this module resolves the same one.
interface State {
  config: DbConfig | null;
  pool: Pool | null;
}
const SLOT = Symbol.for('@ratio/data-db.state');
const store = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = store[SLOT] ?? (store[SLOT] = { config: null, pool: null });

// The APP injects DB config at its composition root (server.ts / a script / the test bootstrap).
// This library reads NO process.env — configuration is the caller's job. Call before first use;
// the pool is created lazily on the first query, so importing `pool` never opens a connection.
export function configureDb(config: DbConfig): void {
  state.config = config;
}

function real(): Pool {
  if (state.pool) return state.pool;
  if (!state.config) {
    throw new Error(
      '@ratio/data-db: configureDb({ connectionString }) must be called at startup before the pool is used'
    );
  }
  const managedTls = /neon\.tech|sslmode=require/.test(state.config.connectionString);
  state.pool = new Pool({
    connectionString: state.config.connectionString,
    ssl: managedTls ? { rejectUnauthorized: !state.config.insecureTls } : undefined,
  });
  // An idle client can emit 'error' (e.g. Neon drops it). With no listener Node crashes; the pool
  // discards the bad client on its own, so we only observe it (L-3).
  state.pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return state.pool;
}

// Lazily-initialised pool. `import { pool }` keeps working unchanged; every call forwards to the
// real Pool, created on first use from the injected config (throws if none was injected).
export const pool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    const p = real();
    const v = Reflect.get(p as object, prop, p);
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(p) : v;
  },
}) as Pool;
