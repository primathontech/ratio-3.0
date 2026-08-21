// Service worker registration for the storefront (OFCE-726). A store OPTS IN by shipping a `sw.js` file
// in its theme bundle; the origin then serves it at /sw.js (root scope) and injects the registration
// snippet below. A store with no sw.js keeps the strict no-JS default — nothing here runs.
//
// The registration is a single, fixed inline snippet authorized by its CSP HASH (not 'self' /
// 'unsafe-inline'), so ONLY these exact bytes may execute — the tightest relaxation that still lets a
// SW register. Paired with worker-src 'self' for the worker itself.
import { createHash } from 'node:crypto';

// Register after load so it never competes with the critical render. Kept as ONE constant so the emitted
// bytes and the CSP hash below can never drift apart (a mismatch would silently block registration).
export const SW_REGISTER_SNIPPET =
  "if('serviceWorker'in navigator){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js')})}";

// The <script> emitted into the head when the store ships a sw.js.
export const SW_REGISTER_TAG = `<script>${SW_REGISTER_SNIPPET}</script>`;

// The CSP source that authorizes EXACTLY the snippet above.
export const SW_SCRIPT_HASH = `'sha256-${createHash('sha256')
  .update(SW_REGISTER_SNIPPET)
  .digest('base64')}'`;

// The extra CSP a store WITH a service worker needs: run the registration snippet (by hash) + allow the
// same-origin worker. Merged onto STOREFRONT_BASE_CSP only for such stores.
export const SW_CSP: Record<string, string[]> = {
  'script-src': [SW_SCRIPT_HASH],
  'worker-src': ["'self'"],
};

export const SERVICE_WORKER_PATH = 'sw.js'; // the bundle key + the served path (/sw.js), root scope

// The conservative default service worker served to every store that hasn't authored its own — enough
// to make the store installable + offline-resilient WITHOUT risking stale content. HTML is NETWORK-FIRST
// (never serves a stale page past an edge purge; falls back to cache only when offline); the immutable,
// content-hashed /assets/<hash> are cache-first (safe — their URL changes when the bytes change).
// skipWaiting + clients.claim so a new SW version takes over promptly. A merchant's own sw.js overrides.
export const DEFAULT_SERVICE_WORKER = `const C='ratio-v1';
self.addEventListener('install',function(e){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(clients.claim())});
self.addEventListener('fetch',function(e){
  var r=e.request;if(r.method!=='GET')return;
  var u=new URL(r.url);if(u.origin!==location.origin)return;
  if(u.pathname.indexOf('/assets/')===0){
    e.respondWith(caches.open(C).then(function(c){return c.match(r).then(function(h){return h||fetch(r).then(function(res){c.put(r,res.clone());return res})})}));
    return;
  }
  e.respondWith(fetch(r).then(function(res){var cp=res.clone();caches.open(C).then(function(c){c.put(r,cp)});return res}).catch(function(){return caches.match(r)}));
});
`;
