// Bundle the container apps (origin + admin-api) to self-contained ESM with esbuild, so the runtime
// image runs plain `node dist/<app>/server.js` — no `tsx` (no first-request TS-compile cold-start)
// and no node_modules/source in the image (smaller image). Packages stay source-.ts for the tsx dev
// loop + the edge; only this prod build compiles them.
import { build } from 'esbuild';

// pg (and other CJS deps) call require() for Node built-ins; ESM output shims require and rejects
// dynamic ones. Restore a real require + __dirname/__filename at the top of each bundle.
const banner = {
  js: [
    "import{createRequire as __cr}from'module';",
    "import{fileURLToPath as __fu}from'url';",
    "import{dirname as __dn}from'path';",
    'const require=__cr(import.meta.url);',
    'const __filename=__fu(import.meta.url);',
    'const __dirname=__dn(__filename);',
  ].join(''),
};

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle', // inline every dep so the runtime needs no node_modules
  banner,
  logLevel: 'info',
  logOverride: { 'require-resolve-not-external': 'silent' },
};

await build({
  ...common,
  entryPoints: ['apps/origin/src/server.ts'],
  outfile: 'dist/origin/server.js',
});
// The untrusted-render isolate spawns ./worker.mjs relative to the bundle (new URL(...,import.meta.url)),
// so it MUST sit next to origin/server.js. Its own bundle inlines liquidjs.
await build({
  ...common,
  entryPoints: ['packages/builder-render/src/worker.mjs'],
  outfile: 'dist/origin/worker.mjs',
});
await build({
  ...common,
  entryPoints: ['apps/admin-api/src/server.ts'],
  outfile: 'dist/admin-api/server.js',
});
