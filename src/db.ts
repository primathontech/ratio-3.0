import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

// tiny .env loader (no dependency) — lets scripts run without passing DATABASE_URL.
try {
  const envPath = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* no .env — fall back to the default below */
}

const connectionString = process.env.DATABASE_URL || 'postgres://poc:poc@localhost:5433/poc';

export const pool = new Pool({
  connectionString,
  // Managed Postgres (Neon) requires TLS; local dev does not.
  ssl: /neon\.tech|sslmode=require/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined,
});
