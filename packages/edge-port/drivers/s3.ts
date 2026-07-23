// S3 driver — the real R2Like (D35: availability store = AWS S3, edge-fetched). StoredResponse is
// serialized as the object body (JSON), so checksum/verify semantics carry over unchanged. Strong
// read-after-write is the property D35 bought — nothing here may weaken it (no caching layer).
//
// SigV4 is hand-rolled (drivers/sigv4.ts) so the SAME driver shape ports into the EdgeWorker
// (fetch + crypto only, no SDK). fetch is injected: unit tests assert exact requests; live tests
// (self-skipping) hit a real bucket.

import type { R2Like, StoredResponse } from '../../spine/stores';
import { signV4, amzDate, type AwsCredentials } from './sigv4';
import type { FetchLike } from './fastpurge';
import { createHash } from 'node:crypto';

export interface S3Location {
  bucket: string;
  region: string; // ap-south-1 (D37: India-only)
  endpoint?: string; // override for testing / non-AWS S3-compatibles
}

// RFC 3986 unreserved-only encoding (SigV4 contract). encodeURIComponent alone mishandles !'()*.
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );

export class S3Driver implements R2Like {
  private host: string;
  private creds: AwsCredentials;

  constructor(
    aws: { accessKeyId: string; secretAccessKey: string },
    private loc: S3Location,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {
    this.host = loc.endpoint ?? `${loc.bucket}.s3.${loc.region}.amazonaws.com`;
    this.creds = { ...aws, region: loc.region, service: 's3' };
  }

  // object keys can contain '|' etc. from cacheKey — encode each path segment for the URI.
  // SigV4 requires strict RFC 3986 encoding: encodeURIComponent leaves !'()* raw, and AWS
  // explicitly warns standard URI encoders break signatures on those characters.
  private objectPath(key: string): string {
    return '/' + key.split('/').map(rfc3986).join('/');
  }

  private async call(
    method: string,
    path: string,
    query = '',
    body = ''
  ): Promise<{ status: number; text(): Promise<string> }> {
    const dateTime = amzDate();
    const headers: Record<string, string> = {
      host: this.host,
      'x-amz-date': dateTime,
      'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
    };
    const auth = signV4(
      { method, host: this.host, path, query, headers, body },
      this.creds,
      dateTime
    );
    const sendHeaders: Record<string, string> = { ...headers, authorization: auth };
    delete sendHeaders.host; // fetch sets Host itself
    return this.fetchImpl(`https://${this.host}${path}${query ? '?' + query : ''}`, {
      method,
      headers: sendHeaders,
      ...(body ? { body } : {}),
    });
  }

  async get(key: string): Promise<StoredResponse | null> {
    const res = await this.call('GET', this.objectPath(key));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`s3 get failed: HTTP ${res.status}`);
    return JSON.parse(await res.text()) as StoredResponse;
  }

  async put(key: string, val: StoredResponse): Promise<void> {
    const res = await this.call('PUT', this.objectPath(key), '', JSON.stringify(val));
    if (res.status !== 200) throw new Error(`s3 put failed: HTTP ${res.status}`);
  }

  async delete(key: string): Promise<void> {
    const res = await this.call('DELETE', this.objectPath(key));
    if (res.status !== 204 && res.status !== 404)
      throw new Error(`s3 delete failed: HTTP ${res.status}`);
  }

  // ListObjectsV2 with continuation — a truncated listing silently missing objects would make a
  // GC pass delete-safe checks against an incomplete world. Query params stay ALPHABETICALLY
  // sorted (continuation-token < list-type < prefix) — SigV4 canonicalizes by sorted query.
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const query =
        (token ? `continuation-token=${rfc3986(token)}&` : '') +
        `list-type=2&prefix=${rfc3986(prefix)}`;
      const res = await this.call('GET', '/', query);
      if (res.status !== 200) throw new Error(`s3 list failed: HTTP ${res.status}`);
      const xml = await res.text();
      const re = /<Key>([^<]+)<\/Key>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) keys.push(m[1]);
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated
        ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null)
        : null;
    } while (token);
    return keys;
  }
}

// Env-based construction (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET, AWS_REGION) —
// returns null when absent so live tests self-skip, same pattern as scripts/poc-prod-infra.ts.
export function s3FromEnv(env = process.env): S3Driver | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const bucket = env.S3_BUCKET;
  if (!accessKeyId || !secretAccessKey || !bucket) return null;
  return new S3Driver(
    { accessKeyId, secretAccessKey },
    { bucket, region: env.AWS_REGION ?? 'ap-south-1' }
  );
}
