// AWS Signature Version 4 — hand-rolled because the S3 driver must run where the AWS SDK cannot:
// Akamai EdgeWorkers (no Node APIs, tight bundle budget). Pure functions over (request, creds,
// time) so it's provable against the AWS-published test vector (see edge-port test).
//
// Only what S3 needs: single-chunk requests, UNSIGNED-PAYLOAD not used (we sign the body hash),
// virtual-host or path-style URLs both fine since host is passed in explicitly.

import { createHmac, createHash } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string; // 's3' here; kept explicit so the vector test can use 'iam'
}

export interface AwsRequest {
  method: string;
  host: string;
  path: string; // URI path, already encoded, WITHOUT query
  query: string; // canonical query string ('' if none)
  headers: Record<string, string>; // must include host + x-amz-date
  body: string;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

// 20150830T123600Z form
export function amzDate(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function canonicalRequest(req: AwsRequest): { text: string; signedHeaders: string } {
  const names = Object.keys(req.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) lower[k.toLowerCase()] = v.trim();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const text = [
    req.method.toUpperCase(),
    req.path || '/',
    req.query,
    canonicalHeaders,
    signedHeaders,
    sha256hex(req.body),
  ].join('\n');
  return { text, signedHeaders };
}

export function signV4(
  req: AwsRequest,
  creds: AwsCredentials,
  dateTime: string // amzDate() — passed in so signing is a pure function of its inputs
): string {
  const date = dateTime.slice(0, 8);
  const scope = `${date}/${creds.region}/${creds.service}/aws4_request`;
  const { text, signedHeaders } = canonicalRequest(req);
  const stringToSign = ['AWS4-HMAC-SHA256', dateTime, scope, sha256hex(text)].join('\n');

  const kDate = hmac('AWS4' + creds.secretAccessKey, date);
  const kRegion = hmac(kDate, creds.region);
  const kService = hmac(kRegion, creds.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return (
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}
