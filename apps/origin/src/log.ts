// Origin observability (ADR-0002). Structured, allowlisted JSON events to stdout — on ECS these land
// in CloudWatch, so live debugging is `aws logs tail /ecs/ratio-origin --filter '"evt":"cart_add"'`
// instead of shipping a one-off debug build. Same discipline as the edge access-log
// (packages/edge-core/src/access-log.ts): a FIXED, non-sensitive field set. A token, cookie, secret,
// raw request body, or query string must NEVER enter an event — by construction, not by review.
//
// The commerce funnel is the first surface because its failures were silently swallowed. `cart_add`
// carries the exact datum that diagnoses the "cart id but empty cart" class of bug: `lines` = the
// line count the backend echoed back (0 = the backend took the call but added nothing).
export type CommerceEvent =
  | { evt: 'cart_add'; tenant: string; ok: boolean; variant: string; lines: number }
  | { evt: 'checkout'; tenant: string; ok: boolean }
  | {
      evt: 'commerce_error';
      tenant: string;
      op: 'add' | 'update' | 'get' | 'checkout';
      err: string;
    };

// Emit one structured event. console.log(JSON) IS the logger here (the log sink is stdout), not stray
// debug output — the same call the edge uses. Never pass anything outside CommerceEvent's fields.
export function logEvent(level: 'info' | 'warn' | 'error', e: CommerceEvent): void {
  console.log(JSON.stringify({ lvl: level, ...e }));
}
