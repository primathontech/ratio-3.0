// Observability seam (ADR-008 D-R8): tenant-labelled counters with BOUNDED
// per-tenant cardinality (overflow folds into "_other"; totals stay exact).
export interface Metrics {
  inc(name: string, labels?: { tenant?: string }, by?: number): number;
  total(name: string): number;
  snapshot(): Record<string, Record<string, number>>;
  reset(): void;
}

export function createMetrics({
  maxTenantsPerMetric = 100,
}: { maxTenantsPerMetric?: number } = {}): Metrics {
  const counters = new Map<string, Map<string, number>>();

  return {
    inc(name, { tenant }: { tenant?: string } = {}, by = 1) {
      let m = counters.get(name);
      if (!m) {
        m = new Map();
        counters.set(name, m);
      }
      let label = tenant || '_none';
      if (!m.has(label) && m.size >= maxTenantsPerMetric) label = '_other';
      const next = (m.get(label) || 0) + by;
      m.set(label, next);
      return next;
    },
    total(name) {
      const m = counters.get(name);
      if (!m) return 0;
      let sum = 0;
      for (const v of m.values()) sum += v;
      return sum;
    },
    snapshot() {
      const out: Record<string, Record<string, number>> = {};
      for (const [name, m] of counters) out[name] = Object.fromEntries(m);
      return out;
    },
    reset() {
      counters.clear();
    },
  };
}
