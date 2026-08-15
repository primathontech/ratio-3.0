// Interpreting a commerce getCollections envelope for the onboarding wizard's step-1 verify
// (OFCE-618). Kept separate from app.ts so the shaping — the part with the sharp edge — is unit-tested.

export interface MerchantVerifyResult {
  configured: boolean; // the commerce backend is wired in this environment
  verified: boolean; // the backend confirmed the merchant id (its collections came back successfully)
  collectionCount?: number; // >0 is strong proof; 0 means reachable-but-empty (UI flags "double-check")
}

// CRUCIAL: the shopkit client does NOT throw on a bad/unknown merchant id or a downed backend — it
// resolves a standardized envelope `{ success: false, data: null, error }` (IResponse.success). So
// `verified` MUST gate on `success`, not merely on data being present: reading `data` alone would make
// an invalid id (data:null → []) falsely verify with count 0. On success, the collections live either
// as a bare array or under `data.collections`.
export function interpretCollectionsEnvelope(
  res:
    | { success?: boolean; data?: unknown; meta?: { pagination?: { total?: number } } }
    | null
    | undefined
): MerchantVerifyResult {
  if (!res?.success) return { configured: true, verified: false };
  const data = res.data;
  const collections = Array.isArray(data)
    ? data
    : ((data as { collections?: unknown[] } | null)?.collections ?? []);
  // Prefer the backend's reported TOTAL: the fetch is capped at `first`, so the returned page
  // undercounts a large catalogue (135 collections would show as 100). Fall back to the page length.
  const total = res.meta?.pagination?.total;
  const collectionCount = typeof total === 'number' ? total : collections.length;
  return { configured: true, verified: true, collectionCount };
}
