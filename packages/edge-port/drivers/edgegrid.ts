// Akamai EdgeGrid request signing (EG1-HMAC-SHA256) — the auth scheme every Akamai management
// API (Fast Purge CCU v3, EdgeKV admin) requires. Implemented from the published spec rather than
// pulling the akamai-edgegrid SDK: ~60 lines, no deps, and the drivers stay fetch-shaped so they
// run anywhere (Node origin, scripts, CI).
//
// Scheme: signing key = HMAC-SHA256(client_secret, timestamp), then
//         signature   = HMAC-SHA256(signing key, data-to-sign) where data-to-sign is the
//         tab-joined request canonicalization ending in the auth header sans signature.
// Timestamp format is Akamai's own: yyyyMMddTHH:mm:ss+0000.

import { createHmac, createHash, randomUUID } from 'node:crypto';

export interface EdgeGridCredentials {
  host: string; // e.g. akab-xxxx.luna.akamaiapis.net (no scheme)
  clientToken: string;
  clientSecret: string;
  accessToken: string;
}

export interface SignableRequest {
  method: string; // GET | POST | PUT | DELETE
  path: string; // path + query, e.g. /ccu/v3/invalidate/tag/production
  body?: string; // request body (POST/PUT); hashed into the signature
}

// POST bodies are only signed up to this many bytes (Akamai spec: default max 131072).
const MAX_BODY = 131072;

export function edgeGridTimestamp(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())}+0000`
  );
}

function hmacB64(key: string | Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64');
}

// Sign a request → the Authorization header value. timestamp/nonce injectable for deterministic tests.
export function signEdgeGrid(
  req: SignableRequest,
  creds: EdgeGridCredentials,
  opts?: { timestamp?: string; nonce?: string }
): string {
  const timestamp = opts?.timestamp ?? edgeGridTimestamp();
  const nonce = opts?.nonce ?? randomUUID();

  // content hash: base64(SHA256(body)) for POST with a body, else empty. Only POST is hashed per spec.
  let contentHash = '';
  if (req.method.toUpperCase() === 'POST' && req.body) {
    const capped = Buffer.from(req.body).subarray(0, MAX_BODY);
    contentHash = createHash('sha256').update(capped).digest('base64');
  }

  const authNoSig =
    `EG1-HMAC-SHA256 client_token=${creds.clientToken};` +
    `access_token=${creds.accessToken};timestamp=${timestamp};nonce=${nonce};`;

  // canonicalization: method, scheme, host, path+query, canonical headers (we sign none — Akamai
  // APIs don't require any by default), content hash, auth header sans signature — tab-joined.
  const dataToSign = [
    req.method.toUpperCase(),
    'https',
    creds.host.toLowerCase(),
    req.path,
    '', // no signed headers
    contentHash,
    authNoSig,
  ].join('\t');

  const signingKey = hmacB64(creds.clientSecret, timestamp);
  const signature = hmacB64(signingKey, dataToSign);
  return `${authNoSig}signature=${signature}`;
}

// Read EdgeGrid credentials from env (AKAMAI_HOST, AKAMAI_CLIENT_TOKEN, AKAMAI_CLIENT_SECRET,
// AKAMAI_ACCESS_TOKEN). Returns null when absent → live tests self-skip.
export function edgeGridFromEnv(env = process.env): EdgeGridCredentials | null {
  const host = env.AKAMAI_HOST;
  const clientToken = env.AKAMAI_CLIENT_TOKEN;
  const clientSecret = env.AKAMAI_CLIENT_SECRET;
  const accessToken = env.AKAMAI_ACCESS_TOKEN;
  if (!host || !clientToken || !clientSecret || !accessToken) return null;
  return { host, clientToken, clientSecret, accessToken };
}
