// Tiny forward-only migration runner (no external dep). Applies db/migrations/*.sql
// in filename order, each in a transaction, recorded in schema_migrations.
import fs from 'fs';
import path from 'path';
import { pool } from '../src/db';

(async () => {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  );
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
    if (rowCount) {
      console.log('skip   ', f);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await pool.query('COMMIT');
      console.log('applied', f);
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
  }
  await pool.end();
})().catch((e: unknown) => {
  console.error('migrate failed:', (e as Error).message);
  process.exit(1);
});
