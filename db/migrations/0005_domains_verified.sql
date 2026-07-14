-- Custom-domain squatting (audit H1): a domain row must not be authoritative for routing until
-- ownership is proven (Cloudflare DV → the custom hostname goes "active"). Until then the claim
-- is reclaimable, so a squat on someone else's domain can't permanently block the real owner.
-- Platform hosts (*.ratiodev.in / *.localhost) are ours, so they are verified on sight.
-- Existing rows are grandfathered verified so live routing is unaffected; the rule governs
-- claims created from here on.
ALTER TABLE domains ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
UPDATE domains SET verified = true;
