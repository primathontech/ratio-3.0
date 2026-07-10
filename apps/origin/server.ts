import { serve } from '@hono/node-server';
import { app } from './index';

// Origin-ONLY entrypoint for the container (AWS App Runner / Fargate). No edge here —
// the edge is the Cloudflare Worker. App Runner injects PORT and needs a 0.0.0.0 bind.
const PORT = Number(process.env.PORT || 8080);

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () =>
  console.log(`origin (Hono, container) listening on 0.0.0.0:${PORT}`)
);
