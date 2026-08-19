// Operational tunables for admin-api — the numeric limits, caps, and TTLs that bound requests and
// background work. Collected here (rather than scattered inline) so an operator can find and adjust them
// in one place; each carries the WHY, and the code that enforces it imports from here. Domain constants
// that only make sense beside their logic (builder-core's money `MINOR`, a bundle byte cap, a resolver
// concurrency) deliberately stay co-located — this file is only the app-level knobs.

// Max stores rebased in a single base-propagation apply (OFCE-633). The rollout is staged (canary → all)
// and each target is a sequential rebase + publish + purge, so one request must not hold a connection
// open over thousands of stores; past this, batch. Well above any real store count in this pre-launch env.
export const MAX_APPLY_TARGETS = 500;

// Per-file cap on a binary theme-asset upload (OFCE-645): the exact size the upload handler enforces
// (413 past it). Only non-scriptable image/font types are allowed (see ALLOWED_ASSET_CONTENT_TYPES).
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

// Request-body limit for the two asset-upload routes: a bit above MAX_ASSET_BYTES to leave room for
// multipart overhead (the boundary + the `path` field). isAssetUploadPath lets the global 1 MB body
// limit step aside for exactly those routes; everything else stays at 1 MB.
export const ASSET_UPLOAD_BODY_LIMIT = MAX_ASSET_BYTES + 64 * 1024;

// Write-through TTL backstop for a published tenant→domain KV mapping (S2 Decision #3: "push-on-change +
// TTL fallback"). Matches the edge's own positive-populate TTL so a stale key — e.g. a control-plane
// unpublish that failed silently — self-heals within an hour: the key expires, the edge misses, and
// re-reads the authoritative verified=true row from Postgres.
export const KV_WRITETHROUGH_TTL = 3600; // seconds (1 hour)

// Max tool-call iterations the storefront assistant's agent loop runs before stopping — a backstop so a
// prompt-injected or looping agent can't churn tool calls indefinitely.
export const MAX_STEPS = 8;
