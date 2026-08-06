import { serve } from '@hono/node-server';
import { configureDb } from '@ratio/data-db';
import { app, resolveEdgeSecret } from './index';
import { config } from './config';

// Origin-ONLY entrypoint for the container (AWS App Runner / Fargate). No edge here —
// the edge is the Cloudflare Worker. App Runner injects PORT and needs a 0.0.0.0 bind.
const PORT = Number(process.env.PORT || 8080);

// Inject DB config before serving; the pool opens lazily on the first query.
configureDb({ connectionString: config.databaseUrl, insecureTls: config.insecureTls });

// Fail fast: refuse to boot in production without a real edge secret (H2 hardening).
resolveEdgeSecret();

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () =>
  console.log(`origin (Hono, container) listening on 0.0.0.0:${PORT}`)
);
