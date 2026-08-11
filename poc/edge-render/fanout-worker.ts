// OFCE-491 · fan-out test. Fire N parallel fetches (simulating N data sources) and record each
// one's completion offset. If the Workers 6-connection window applies, N>6 completes in WAVES
// (~DELAY, ~2×DELAY, …) and the upstream reports maxInflight≈6. If not, all finish in ~one DELAY.
export default {
  async fetch(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const n = Number(q.get('n') ?? 10);
    const delay = Number(q.get('delay') ?? 200);
    // Local: the Node upstream on :8901. Edge: pass ?upstream=https://ofce491-upstream-poc.<sub>.workers.dev/
    const upstream = q.get('upstream') ?? 'http://localhost:8901/';
    const url = `${upstream}${upstream.includes('?') ? '&' : '?'}delay=${delay}`;
    const t0 = performance.now();

    const timeline = await Promise.all(
      Array.from({ length: n }, async (_unused, i) => {
        const r = await fetch(url);
        const body = (await r.json()) as { maxInflight: number };
        return {
          i,
          doneMs: +(performance.now() - t0).toFixed(0),
          upstreamMaxInflight: body.maxInflight,
        };
      })
    );

    const totalMs = +(performance.now() - t0).toFixed(0);
    const maxInflight = Math.max(...timeline.map((t) => t.upstreamMaxInflight));

    return new Response(
      JSON.stringify(
        {
          n,
          totalMs,
          upstreamMaxConcurrent: maxInflight,
          verdict:
            maxInflight <= 6 && n > 6
              ? '6-conn WINDOW APPLIES (fan-out capped at 6)'
              : 'no cap observed',
          timeline,
        },
        null,
        2
      ),
      { headers: { 'content-type': 'application/json' } }
    );
  },
};
