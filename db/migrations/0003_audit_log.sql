-- ADR-016 Phase 1 (OFCE-401): control-plane audit trail. One row per authenticated
-- mutating action on the control plane (who / kind / when / which tenant / what / result).
-- Compliance (ADR-010) + agents edit live stores, so every change must be attributable.
-- Intentionally NO foreign key on tenant_id: the trail must OUTLIVE a provable hard-delete
-- (deleteStore residual counts routes/domains/memberships, not this) so the record that a
-- store existed and was deleted survives. The public data plane never touches this table.
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text        NOT NULL,   -- clerk user id, or the agent token's principal (sub)
  actor_kind text        NOT NULL,   -- 'user' | 'agent'
  tenant_id  text,                   -- store touched; null for non-tenant actions
  action     text        NOT NULL,   -- scope-catalog verb, e.g. 'pages:write', 'stores:onboard'
  method     text        NOT NULL,
  path       text        NOT NULL,
  status     integer     NOT NULL    -- response status code
);
CREATE INDEX IF NOT EXISTS audit_log_tenant_idx ON audit_log (tenant_id, at DESC);
