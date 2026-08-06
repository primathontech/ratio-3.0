// Single source of truth for run-environment intent.
// RATIO_LOCAL=true means "a developer is running this on their machine". Unset means
// staging/prod — the safe default, so nothing dev-only ever turns on by accident.
export const isLocal = process.env.RATIO_LOCAL === 'true';

// Dev-only Clerk signature bypass (lets a local admin run without the Clerk secret).
// Allowed when local, or when explicitly asked via DEV_INSECURE_CLERK — but HARD-blocked
// whenever NODE_ENV=production. The Dockerfile sets NODE_ENV=production on every deployed
// container, so this can never authenticate in staging or prod regardless of RATIO_LOCAL.
export const devInsecureClerk =
  process.env.NODE_ENV !== 'production' && (isLocal || process.env.DEV_INSECURE_CLERK === 'true');
