// Binary theme assets (OFCE-631 / LLD BC4). The text bundle stays text-only; a theme's binary assets
// (favicon, images, fonts, prebuilt JS) live OUTSIDE it as content-addressed objects, indexed by a
// manifest that DOES ride in the text bundle. So the manifest composes via base⊕overrides and freezes
// per publish exactly like every other theme file, while the (large, immutable) bytes stay separate.
import { createHash } from 'node:crypto';
import type { ThemeFiles } from './bundle';

// The manifest lives in the text bundle at this path: a JSON map of the logical asset path a theme
// references (e.g. 'favicon.ico', 'images/logo.png') → the content hash of its bytes + how to serve it.
export const ASSET_MANIFEST_PATH = 'config/assets.json';

// A sha256 hex content address is 64 lowercase hex chars. The hash is interpolated into an S3 object
// key AND arrives from the (merchant-editable) manifest, so it MUST be validated before it touches a
// key — otherwise a crafted manifest hash could traverse out of the theme's asset prefix.
const ASSET_HASH_RE = /^[a-f0-9]{64}$/;
export function isAssetHash(hash: string): boolean {
  return ASSET_HASH_RE.test(hash);
}

export interface AssetEntry {
  hash: string; // sha256 hex of the bytes — the content address (and the object key)
  contentType: string; // MIME type to serve the bytes with (set at upload, from validation)
  size: number; // byte length
}
export type AssetManifest = Record<string, AssetEntry>;

// The content address of asset bytes: sha256 hex. Identical bytes → identical hash → dedup + immutable
// + safe to cache forever on a CDN.
export function assetHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Parse the manifest out of a theme's files. Absent, malformed, or wrong-shaped input yields {} (never
// throws mid-render); only well-formed, hash-valid entries survive, so a hand-edited manifest can't
// inject an unexpected shape or a traversal hash downstream.
export function readAssetManifest(files: ThemeFiles): AssetManifest {
  const raw = files[ASSET_MANIFEST_PATH];
  if (raw == null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: AssetManifest = {};
  for (const [path, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v == null || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    if (
      typeof e.hash === 'string' &&
      isAssetHash(e.hash) &&
      typeof e.contentType === 'string' &&
      typeof e.size === 'number'
    ) {
      // defineProperty (not out[path] = …) so a path literally named "__proto__"/"constructor" becomes
      // a real own data entry instead of hitting the prototype setter — no prototype pollution, no
      // silent drop. Same guard bundle.ts uses on untrusted JSON keys.
      Object.defineProperty(out, path, {
        value: { hash: e.hash, contentType: e.contentType, size: e.size },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return out;
}

// Write the manifest back into the files as CANONICAL JSON: paths in lexicographic order and each
// entry's fields in a fixed order (hash, contentType, size). Built by hand rather than
// JSON.stringify(object) on purpose — an object literal would reorder integer-like keys numerically
// and preserve whatever field order the caller happened to build, either of which would make an
// identical logical manifest serialize to different bytes (→ a different bundle hash → a spurious new
// version). Emptying it drops the file entirely rather than leaving an empty object behind.
export function writeAssetManifest(files: ThemeFiles, manifest: AssetManifest): ThemeFiles {
  const paths = Object.keys(manifest).sort();
  const next: ThemeFiles = { ...files };
  if (paths.length === 0) {
    delete next[ASSET_MANIFEST_PATH];
    return next;
  }
  const body = paths
    .map((p) => {
      const e = manifest[p];
      const entry = JSON.stringify({ hash: e.hash, contentType: e.contentType, size: e.size });
      return `  ${JSON.stringify(p)}: ${entry}`;
    })
    .join(',\n');
  next[ASSET_MANIFEST_PATH] = `{\n${body}\n}\n`;
  return next;
}
