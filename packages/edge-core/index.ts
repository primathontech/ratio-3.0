// @ratio/edge-core — portable, platform-agnostic edge logic shared by every edge adapter
// (the Cloudflare Worker today, Akamai EdgeWorkers next). No platform binding lives here; adapters
// inject their KV / cache / fetch / dataset. See "Edge Platform" gap analysis for the strategy.
export * from './headers';
export * from './circuit-breaker';
export * from './serve-origin';
export * from './tenant-resolve';
export * from './access-log';
export * from './store-unavailable';
