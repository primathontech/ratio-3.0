const fs = require('fs');
const path = require('path');

// tiny .env loader (no dependency) — lets `npm start` / `npm run prove` work
// without passing DATABASE_URL every time.
try {
  const envPath = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* no .env — fall back to the default below */
}

const { Pool } = require('pg');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://poc:poc@localhost:5433/poc',
});

module.exports = { pool };
