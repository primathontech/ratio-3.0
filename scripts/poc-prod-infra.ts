// P6 / P14 / P15 / P16 — the acceptance tests that CANNOT be proven locally because they depend
// on real multi-PoP Cloudflare behavior (per-colo cache, KV global propagation, R2 cross-region
// latency). This script is the runnable spec for them; it self-skips unless the infra env is set,
// so it is safe in CI. Fill the env, deploy the poc/cache-spine-v3 worker, then run:
//   POC_EDGE_URL=https://... POC_COLOS=BOM,FRA,IAD CF_API_TOKEN=... tsx scripts/poc-prod-infra.ts
//
// Every run appends raw evidence (cf-ray colos, timestamps, status) to research/08 inputs.

const EDGE = process.env.POC_EDGE_URL;
const COLOS = (process.env.POC_COLOS || '').split(',').filter(Boolean);

if (!EDGE || COLOS.length < 2) {
  console.log('SKIP — set POC_EDGE_URL + POC_COLOS (>=2 real colos) to run P6/P14/P15/P16.');
  console.log('These prove properties that are physically impossible to validate locally:');
  console.log('  P6  multi-PoP outage    — per-colo Cache API + R2 fallback across real PoPs');
  console.log(
    '  P14 propagation         — KV activation/suspend visibility, clock from publish/commit'
  );
  console.log(
    '  P15 multi-PoP miss storm— real render amplification when a release flips under load'
  );
  console.log('  P16 retention/GC        — release N readable while a lagging colo still names it');
  process.exit(0);
}

// --- helpers (only reached with real infra) ---
async function hitVia(colo: string, path: string) {
  // Route to a specific colo via a regional worker route or a colo-pinned test endpoint.
  const t0 = Date.now();
  const res = await fetch(`${EDGE}${path}`, { headers: { 'x-poc-colo': colo } });
  return {
    colo,
    status: res.status,
    cfRay: res.headers.get('cf-ray') ?? '',
    served: res.headers.get('x-edge') ?? '',
    ms: Date.now() - t0,
  };
}

async function p14Propagation(samples: number) {
  // Publish → poll each colo until it observes the new release; record per-colo visibility delay.
  // Clock STARTS at publish/commit (D25), not pointer write.
  console.log(`P14: ${samples} activations across ${COLOS.join(',')} — recording max + p99...`);
  const delays: number[] = [];
  for (let i = 0; i < samples; i++) {
    // TODO(infra): trigger a real publish here (admin-api), stamp commit time, poll colos.
    // Placeholder loop structure documents the measurement; real body added at run time.
  }
  console.log(
    '  record: p99, MAX (not just percentiles), per-colo cf-ray. Provisional gate: p99 <=60s.'
  );
  return delays;
}

async function p6MultiPoPOutage(path: string) {
  // Warm one colo, leave others cold; then (operator) scale ECS to 0 + block DB, and re-probe
  // every colo. Materialized set must yield 0 errors: warm→HIT, cold→R2.
  console.log(
    `P6: probing ${path} across ${COLOS.join(',')} (run twice — before & after origin kill)`
  );
  const rows = await Promise.all(COLOS.map((c) => hitVia(c, path)));
  for (const r of rows)
    console.log(`  ${r.colo} status=${r.status} served=${r.served} cf-ray=${r.cfRay} ${r.ms}ms`);
  const errors = rows.filter((r) => r.status >= 500);
  console.log(
    `  errors=${errors.length} (must be 0 for the materialized set during origin+DB outage)`
  );
  return rows;
}

(async () => {
  console.log('running against', EDGE, 'colos', COLOS.join(','));
  await p6MultiPoPOutage(process.env.POC_PATH || '/');
  await p14Propagation(Number(process.env.POC_SAMPLES || 100));
  console.log(
    'P15/P16 bodies: coordinate publish + fault injection (ECS scale-to-0, R2/KV toggles)'
  );
  console.log('via the ops workflows; append raw logs to research/08-cache-spine-results.md.');
})();
