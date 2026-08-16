// Dev: wipe all local store data so you can onboard fresh. Truncates every app table except
// schema_migrations (so no re-migrate is needed). New stores get fresh tenant ids, so any leftover
// theme bundles in the object store are harmless orphans.
// Usage: bun run reset:local
import { pool } from '@ratio/data-db';
import { configureDbFromEnv } from './db';

configureDbFromEnv();

(async () => {
  const { rows } = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname='public' and tablename <> 'schema_migrations'"
  );
  if (rows.length === 0) {
    console.log('nothing to clear — no app tables found');
  } else {
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    const n = await pool.query<{ n: number }>('select count(*)::int n from tenants');
    console.log(`cleared ${rows.length} tables — tenants: ${n.rows[0].n}`);
  }
  await pool.end();
})().catch((e: unknown) => {
  console.error('reset failed:', (e as Error).message);
  process.exit(1);
});
