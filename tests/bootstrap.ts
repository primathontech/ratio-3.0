import { configureDb } from '@ratio/data-db';

// Test composition root. Loaded via `node --import ./tests/bootstrap.ts` before any test file, so
// the lazy pool (@ratio/data-db) has its config the moment a test first queries. The test scripts
// set DATABASE_URL to the test DB; missing it is a setup error, not something to paper over.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is required to run the tests (see the test script in package.json)'
  );
}
configureDb({ connectionString, insecureTls: process.env.DB_INSECURE_TLS === 'true' });
