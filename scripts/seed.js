// Applies db/seed.sql via the app's pool (idempotent: seed uses ON CONFLICT DO NOTHING).
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
  await pool.query(sql);
  console.log('seeded');
  await pool.end();
})().catch((e) => {
  console.error('seed failed:', e.message);
  process.exit(1);
});
