// Last-good writer (D44). The S3 backstop is written by the ORIGIN after a successful render —
// never by the edge (Akamai EdgeWorkers has no waitUntil; the edge only READS last-good).
//
// The problem this class exists for (review blocker #4): fire-and-forget writes to one live key
// race — a delayed v1 write can land AFTER v2 and win, regressing content; worse, an old 200 can
// overwrite a newer 404 tombstone and resurrect a deleted page (violating D41). Two defences:
//   1. every write carries a MONOTONIC generation (the page's DB revision — bumped on every save
//      AND delete), and a write is dropped if the stored object's generation is >= its own;
//   2. writes to the same key are serialized in-process (promise chain per key), so the
//      read-generation → put window can't interleave within one origin instance.
// Honest limit: across MULTIPLE origin instances the read→put window still exists (S3 has no
// compare-and-swap on overwrite). The generation check makes stale-wins vanishingly unlikely but
// not impossible; the real fix at scale is a single per-tenant writer (outbox consumer) — noted
// in MOM, not built.

import type { R2Like, StoredResponse } from '../spine/stores';

export class LastGoodStore {
  private chains = new Map<string, Promise<void>>();

  constructor(private store: R2Like) {}

  get(key: string): Promise<StoredResponse | null> {
    return this.store.get(key);
  }

  // Write-behind: never throws into the render path (a failed backstop write must not fail the
  // response), never lets an older generation overwrite a newer one.
  writeIfNewer(key: string, res: StoredResponse, generation: number): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        let existing: StoredResponse | null = null;
        try {
          existing = await this.store.get(key);
        } catch {
          /* unreadable = treat as absent; the put below may still fail and be swallowed */
        }
        if ((existing?.generation ?? -1) >= generation) return; // stale write — drop it
        await this.store.put(key, { ...res, generation });
      })
      .catch(() => {});
    this.chains.set(key, next);
    return next;
  }

  // Await every in-flight write — deterministic assertions in tests, drain hook on shutdown.
  async settle(): Promise<void> {
    await Promise.all(this.chains.values());
  }
}
