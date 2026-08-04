// Fast Purge (CCU v3) driver — the real PurgeLike. POST /ccu/v3/{action}/tag/{network} with
// {objects: [tags]}. `invalidate` = mark-stale + serve-until-revalidated (the D38 default);
// `delete` = hard remove (emergency only — it reopens the "nothing to serve stale" hole).
// Akamai SLA: purge completes in ~5s worldwide. EW-3 measures the real number.

import type { PurgeLike } from '../akamai-cache';
import { signEdgeGrid, type EdgeGridCredentials } from './edgegrid';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{ status: number; text(): Promise<string> }>;

export type AkamaiNetwork = 'staging' | 'production';

export class FastPurgeDriver implements PurgeLike {
  constructor(
    private creds: EdgeGridCredentials,
    private network: AkamaiNetwork = 'production',
    // fetch injected so unit tests assert the exact request without any network
    private fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  async invalidateByTags(tags: string[]): Promise<void> {
    await this.purge('invalidate', tags);
  }

  async deleteByTags(tags: string[]): Promise<void> {
    await this.purge('delete', tags);
  }

  private async purge(action: 'invalidate' | 'delete', tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    const path = `/ccu/v3/${action}/tag/${this.network}`;
    const body = JSON.stringify({ objects: tags });
    const auth = signEdgeGrid({ method: 'POST', path, body }, this.creds);
    const res = await this.fetchImpl(`https://${this.creds.host}${path}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body,
    });
    // 201 = accepted (async completion). Anything else = the purge did NOT happen — surface it;
    // callers must not proceed as if content was invalidated.
    if (res.status !== 201) {
      throw new Error(`fast purge ${action} failed: HTTP ${res.status} ${await res.text()}`);
    }
  }
}
