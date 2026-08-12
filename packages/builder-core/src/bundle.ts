// A theme "bundle": the on-S3 form of a theme (LLD BC0/BC1). The theme's TEXT source files (Liquid,
// JSON templates, CSS) packed into ONE compressed blob, content-addressed by a stable hash of the
// canonical contents — we store one bundle, never one object per file. Binary assets (images, fonts)
// are NOT bundled: they are separate content-addressed objects referenced by URL (LLD BC4). Pure
// functions (gzip + sha256), no I/O.
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// path -> file content (UTF-8 text). This is the text source tree; binary assets live elsewhere.
export type ThemeFiles = Record<string, string>;

// Cap on a bundle's DECOMPRESSED size. Bundles are text source (KBs–low MBs); this bounds a zip-bomb
// or malformed blob from OOMing the shared origin (unpackBundle runs on merchant-controlled input).
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

// Canonical form: a path-sorted array of [path, content] PAIRS. An array (not an object) so a file
// literally named "__proto__" round-trips verbatim — assigning it onto a plain object would hit the
// prototype setter and silently drop it (data loss + a hash that omits it). Fixed order → identical
// files always serialize identical bytes → identical content address.
function canonical(files: ThemeFiles): string {
  const pairs = Object.keys(files)
    .sort()
    .map((path) => [path, files[path]] as const);
  return JSON.stringify(pairs);
}

// The content address: sha256 hex over the canonical form. Identical file sets share an id; any
// add/remove/edit changes it. Hashes the CONTENTS (not the gzip bytes) → codec-independent.
export function bundleId(files: ThemeFiles): string {
  return createHash('sha256').update(canonical(files)).digest('hex');
}

// Pack the files into one gzipped blob — the object we put in S3.
export function packBundle(files: ThemeFiles): Buffer {
  return gzipSync(Buffer.from(canonical(files), 'utf8'));
}

// Unpack a blob back into the files, rejecting one that decompresses beyond `maxOutputLength`
// (zip-bomb guard). Round-trips packBundle exactly. Uses defineProperty (not `out[path] =`) so a file
// named "__proto__" becomes a real data entry — never the prototype setter — with no silent drop and
// no prototype pollution.
export function unpackBundle(blob: Buffer, maxOutputLength = MAX_BUNDLE_BYTES): ThemeFiles {
  const json = gunzipSync(blob, { maxOutputLength }).toString('utf8');
  const pairs = JSON.parse(json) as [string, string][];
  const out: ThemeFiles = {};
  for (const [path, content] of pairs) {
    Object.defineProperty(out, path, {
      value: content,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
