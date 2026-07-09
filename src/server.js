const { origin } = require('./origin');
const { edge } = require('./edge');

const ORIGIN_PORT = Number(process.env.ORIGIN_PORT || 9090);
const EDGE_PORT = Number(process.env.EDGE_PORT || 8080);

origin.listen(ORIGIN_PORT, '127.0.0.1', () =>
  console.log(`origin (private shared host) → 127.0.0.1:${ORIGIN_PORT}`)
);
edge.listen(EDGE_PORT, () =>
  console.log(`edge   (fake CDN)           → http://localhost:${EDGE_PORT}  (try Host: acme.localhost / beta.localhost)`)
);
