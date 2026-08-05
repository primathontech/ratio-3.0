-- Per-tenant commerce backend config (data binding). The @shopkit/data-layer CUSTOM adapter needs
-- a merchantId + storeId to fetch a store's products/collections; these are PER-MERCHANT, so they
-- live on the tenant (not env — env holds only the platform-wide service base URLs). storeId is
-- currently the same as merchantId; kept separate so it can diverge later.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS commerce jsonb;
