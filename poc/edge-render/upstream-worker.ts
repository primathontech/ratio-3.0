// OFCE-491 · edge-deployable mock upstream (a Worker, so the fan-out Worker can reach it over the
// real edge — localhost isn't reachable from a deployed Worker). Waits DELAY ms, then replies with
// the max concurrent it has seen in THIS isolate. Concurrency counting is best-effort (requests may
// land on different isolates), so the fan-out Worker's TOTAL wall-clock is the primary signal.
let inFlight = 0;
let maxInFlight = 0;

export default {
  async fetch(req: Request): Promise<Response> {
    const delay = Number(new URL(req.url).searchParams.get('delay') ?? 200);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, delay));
    inFlight--;
    return new Response(JSON.stringify({ ok: true, maxInFlight }), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
