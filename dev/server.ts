import { serve } from '@hono/node-server';
import { configureDb } from '@ratio/data-db';
import { app } from '../apps/origin/src/index';
import { config } from '../apps/origin/src/config';
import { edge } from './edge-sim';

// Inject DB config before serving; the pool opens lazily on the first query.
configureDb({ connectionString: config.databaseUrl, insecureTls: config.insecureTls });

const ORIGIN_PORT = Number(process.env.ORIGIN_PORT || 9090);
const EDGE_PORT = Number(process.env.EDGE_PORT || 8080);

// origin = Hono app on a container (Node adapter); edge = the CDN simulator (Node http).
serve({ fetch: app.fetch, port: ORIGIN_PORT, hostname: '127.0.0.1' }, () =>
  console.log(`origin (private shared host, Hono) → 127.0.0.1:${ORIGIN_PORT}`)
);
edge.listen(EDGE_PORT, () =>
  console.log(
    `edge   (fake CDN)           → http://localhost:${EDGE_PORT}  (try Host: acme.localhost / beta.localhost)`
  )
);
