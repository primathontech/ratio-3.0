// EdgeKV driver — the real KVLike for the CONTROL PLANE (host→tenant writes at onboard/suspend,
// write-before-DNS per D29). Talks the EdgeKV admin REST API with EdgeGrid auth.
//
// NOTE the split: EdgeWorker RUNTIME reads use the `edgekv.js` helper inside the worker (see
// edgeworker/main.ts) — sub-millisecond, local to the PoP. THIS driver is the management path:
// writes propagate globally in ≤10s (EdgeKV's published bound; EW-2 measures the real number,
// which feeds the D25 freshness SLO directly).

import type { KVLike } from '../../spine/stores';
import { signEdgeGrid, type EdgeGridCredentials } from './edgegrid';
import type { FetchLike } from './fastpurge';
import { edgeKvItemKey } from '../edgekv-key';

export interface EdgeKVLocation {
  network: 'staging' | 'production';
  namespace: string;
  group: string;
}

export class EdgeKVDriver implements KVLike {
  constructor(
    private creds: EdgeGridCredentials,
    private loc: EdgeKVLocation,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  private itemPath(key: string): string {
    const { network, namespace, group } = this.loc;
    // EdgeKV item IDs permit only [0-9a-zA-Z_-] — URL-encoding does NOT help (% is disallowed).
    // edgeKvItemKey is the shared base64url encoding the EdgeWorker uses for its reads too.
    return `/edgekv/v1/networks/${network}/namespaces/${namespace}/groups/${group}/items/${edgeKvItemKey(key)}`;
  }

  private async call(
    method: string,
    path: string,
    body?: string
  ): Promise<{ status: number; text(): Promise<string> }> {
    const auth = signEdgeGrid({ method, path, body }, this.creds);
    return this.fetchImpl(`https://${this.creds.host}${path}`, {
      method,
      headers: {
        authorization: auth,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    });
  }

  async get(key: string): Promise<string | null> {
    const res = await this.call('GET', this.itemPath(key));
    if (res.status === 404) return null; // absent is a VALUE (fail-closed 404 at edge), not an error
    if (res.status !== 200) throw new Error(`edgekv get failed: HTTP ${res.status}`);
    return res.text();
  }

  async put(key: string, val: string): Promise<void> {
    const res = await this.call('PUT', this.itemPath(key), val);
    // 200/201 both observed for upserts
    if (res.status !== 200 && res.status !== 201)
      throw new Error(`edgekv put failed: HTTP ${res.status} ${await res.text()}`);
  }

  async delete(key: string): Promise<void> {
    const res = await this.call('DELETE', this.itemPath(key));
    if (res.status !== 200 && res.status !== 404)
      throw new Error(`edgekv delete failed: HTTP ${res.status}`);
  }
}
