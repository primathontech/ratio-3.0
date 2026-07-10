// Applies db/seed.sql via the app pool (idempotent: seed uses ON CONFLICT DO NOTHING).
import fs from 'fs';
import path from 'path';
import { pool } from '../src/db';

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
  await pool.query(sql);
  console.log('seeded');
  await pool.end();
})().catch((e: unknown) => {
  console.error('seed failed:', (e as Error).message);
  process.exit(1);
});
