// OFCE-491 · a mock data-layer upstream. Each request waits DELAY ms then replies, and reports the
// MAX concurrent in-flight requests it has seen — so we can observe whether the Worker's 6-connection
// window caps our fan-out.
import http from 'node:http';

const DELAY = Number(process.env.DELAY ?? 200);
let inflight = 0;
let maxInflight = 0;

http
  .createServer((_req, res) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    setTimeout(() => {
      inflight--;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, maxInflight }));
    }, DELAY);
  })
  .listen(8901, () => console.log(`upstream on :8901, delay ${DELAY}ms`));
