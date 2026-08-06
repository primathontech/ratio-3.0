// The edge<->origin shared secret, resolved from an injected env (the library reads no process.env
// itself — the caller passes its own). Fails closed: in production it MUST be set, or the private
// origin would accept a secret that lives in the source tree. The dev default keeps local runs
// frictionless and is the ONE place that literal lives — every caller resolves through here.
export function resolveEdgeSecret(env: { EDGE_SECRET?: string; NODE_ENV?: string }): string {
  if (env.EDGE_SECRET) return env.EDGE_SECRET;
  if (env.NODE_ENV === 'production') throw new Error('EDGE_SECRET must be set in production');
  return 'private-link-secret';
}
