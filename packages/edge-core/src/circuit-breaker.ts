// Per-dependency circuit breaker (ADR-008 D-R3). After `threshold` consecutive failures it opens;
// while open, callers skip the dead dependency entirely (no timeout wait) for `cooldownMs`, then
// half-open for one trial (success closes, failure re-opens). State is module-scoped → per-isolate:
// each edge isolate learns on its own, which is enough (no global consensus needed). `now` is
// injected for deterministic tests and defaults to the wall clock at the edge.
//
// NOTE (Akamai): EdgeWorkers don't hold reliable per-isolate state across requests, so an adapter
// there would back this with EdgeKV or drop it. The state machine itself is platform-agnostic.
export interface CircuitBreaker {
  canAttempt(): boolean;
  onSuccess(): void;
  onFailure(): void;
}
export function createCircuitBreaker(
  threshold: number,
  cooldownMs: number,
  now: () => number = () => Date.now()
): CircuitBreaker {
  let failures = 0;
  let openedAt: number | null = null;
  return {
    canAttempt() {
      if (openedAt === null) return true;
      return now() - openedAt >= cooldownMs;
    },
    onSuccess() {
      failures = 0;
      openedAt = null;
    },
    onFailure() {
      failures += 1;
      if (failures >= threshold) openedAt = now();
    },
  };
}
