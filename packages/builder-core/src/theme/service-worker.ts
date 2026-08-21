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
