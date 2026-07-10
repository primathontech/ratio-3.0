// Observability seam (ADR-008 D-R8): tenant-labelled counters (renders, cache
// hit/miss, rate-limit blocks, ...). Per-tenant cardinality is BOUNDED — once a
// metric has maxTenantsPerMetric distinct tenant labels, further tenants fold into
// "_other" so cardinality can't explode the metrics backend. Totals stay exact.
function createMetrics({ maxTenantsPerMetric = 100 } = {}) {
  const counters = new Map(); // name -> Map(label -> count)

  function inc(name, { tenant } = {}, by = 1) {
    let m = counters.get(name);
    if (!m) {
      m = new Map();
      counters.set(name, m);
    }
    let label = tenant || '_none';
    if (!m.has(label) && m.size >= maxTenantsPerMetric) label = '_other';
    m.set(label, (m.get(label) || 0) + by);
    return m.get(label);
  }

  function total(name) {
    const m = counters.get(name);
    if (!m) return 0;
    let sum = 0;
    for (const v of m.values()) sum += v;
    return sum;
  }

  function snapshot() {
    const out = {};
    for (const [name, m] of counters) out[name] = Object.fromEntries(m);
    return out;
  }

  function reset() {
    counters.clear();
  }

  return { inc, total, snapshot, reset };
}

module.exports = { createMetrics };
