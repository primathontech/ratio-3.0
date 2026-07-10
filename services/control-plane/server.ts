import { serve } from '@hono/node-server';
import { app } from './app';

// Control-plane API entrypoint (its own deploy — separate from the data plane).
const PORT = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () =>
  console.log(`control-plane API → 0.0.0.0:${PORT}`)
);
