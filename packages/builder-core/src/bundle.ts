// A theme "bundle": the on-S3 form of a theme (LLD BC0/BC1). The source (or compiled) files packed
// into ONE compressed blob, content-addressed by a stable hash of the canonical contents — we store
// one bundle, never one object per file. Pure functions (gzip + sha256), no I/O.
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// path → file content (utf-8 text). Both the editable source tree and the compiled render tree use
// this shape; a bundle is just a compressed, content-addressed snapshot of it.
export type ThemeFiles = Record<string, string>;

// Canonical serialization: paths sorted so the same files always produce the same bytes — and thus
// the same content address — regardless of insertion order.
function canonicalize(files: ThemeFiles): string {
  const sorted: ThemeFiles = {};
  for (const path of Object.keys(files).sort()) sorted[path] = files[path];
  return JSON.stringify(sorted);
}

// The content address: sha256 hex over the canonical serialization. Identical file sets share an id;
// any add/remove/edit changes it. Hashing the canonical CONTENTS (not the gzip bytes) keeps the id
// independent of the compression codec/level.
export function bundleId(files: ThemeFiles): string {
  return createHash('sha256').update(canonicalize(files)).digest('hex');
}

// Pack the files into one gzipped blob — the object we put in S3.
export function packBundle(files: ThemeFiles): Buffer {
  return gzipSync(Buffer.from(canonicalize(files), 'utf8'));
}

// Unpack a blob back into the files. Round-trips packBundle exactly.
export function unpackBundle(blob: Buffer): ThemeFiles {
  return JSON.parse(gunzipSync(blob).toString('utf8')) as ThemeFiles;
}
