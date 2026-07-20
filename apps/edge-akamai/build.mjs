// Bundles the EdgeWorker (main.js + the edge-core TypeScript it imports) into a single
// EdgeWorkers-safe ESM file. Run: `npm i -D esbuild` once, then `node apps/edge-akamai/build.mjs`.
// Then package for upload: `tar czf edgeworker.tgz -C apps/edge-akamai/dist main.js -C .. bundle.json`
//
// Proving this bundles cleanly (no Node builtins leak in) is the core of the OFCE-476 sandbox PoC.
import { build } from 'esbuild';

// EdgeWorkers provides these modules at runtime — mark them external so esbuild leaves them alone.
const EDGEWORKER_BUILTINS = [
  'log',
  'http-request',
  'create-response',
  'cookies',
  'url-search-params',
  'html-rewriter',
  'streams',
  'text-encode-transform',
  'crypto',
  './edgekv/edgekv.js',
];

await build({
  entryPoints: ['apps/edge-akamai/main.js'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral', // not node/browser — the EdgeWorkers runtime is neither
  external: EDGEWORKER_BUILTINS,
  outfile: 'apps/edge-akamai/dist/main.js',
  legalComments: 'none',
  logLevel: 'info',
});

console.log('✓ bundled → apps/edge-akamai/dist/main.js');
console.log('  next: tar czf edgeworker.tgz -C apps/edge-akamai/dist main.js -C .. bundle.json');
console.log('  then: akamai sandbox (local) or akamai edgeworkers create-version <ewid> edgeworker.tgz');
