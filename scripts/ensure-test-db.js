// Ensures the test database exists (dep-free; uses pg). Idempotent.
const { Client } = require('pg');

const ADMIN_URL = process.env.ADMIN_URL || 'postgres://localhost:5432/postgres';
const TEST_DB = process.env.TEST_DB || 's2poc_test';

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (!rowCount) {
    await admin.query(`CREATE DATABASE ${TEST_DB}`); // identifier is a constant, not user input
    console.log('created', TEST_DB);
  } else {
    console.log(TEST_DB, 'exists');
  }
  await admin.end();
})().catch((e) => {
  console.error('ensure-test-db failed:', e.message);
  process.exit(1);
});
