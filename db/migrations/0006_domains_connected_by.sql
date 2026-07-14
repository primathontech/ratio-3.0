-- Cross-tenant custom-domain hijack (audit R10-H1): `verified` was promoted from Cloudflare's
-- per-hostname `active` status, which is GLOBAL to the hostname — so whichever tenant held the
-- (reclaimable, unverified) row when a victim's DV completed inherited the verification. Bind
-- verification to the tenant that actually connected: `connected_by` is set when a tenant runs
-- the connect (DV) flow, cleared when a different tenant reclaims, and markDomainVerified only
-- promotes a row whose current tenant IS its connector. Existing verified rows are grandfathered.
ALTER TABLE domains ADD COLUMN IF NOT EXISTS connected_by text;
UPDATE domains SET connected_by = tenant_id WHERE verified = true AND connected_by IS NULL;
