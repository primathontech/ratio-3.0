// The port the local dev edge listens on. Storefront URLs opened from the admin in local dev point at
// `<label>.localhost:${LOCAL_EDGE_PORT}` (see storefrontUrl / liveStoreUrl). Must match the edge port
// in the local dev loop (dev/all.ts) and RATIO_LOCAL provisioning.
export const LOCAL_EDGE_PORT = '8080';
