import { configureDb } from '@ratio/data-db';

// Scripts are composition roots too: they read DATABASE_URL from the environment and inject it
// into the library. Provide it or the script throws — no silent default. For local dev the npm
// scripts load it via --env-file-if-exists=apps/origin/.env; CI/tests set it inline.
export function configureDbFromEnv(): void {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required — set it in the environment (or apps/origin/.env for local dev)'
    );
  }
  configureDb({ connectionString, insecureTls: process.env.DB_INSECURE_TLS === 'true' });
}
