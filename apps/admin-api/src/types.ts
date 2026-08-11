// Shared Hono env for the admin-api route modules (app.ts + routes/*).
export type Vars = { Variables: { userId: string; scope?: string[]; auditTenant?: string } };
