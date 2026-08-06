-- Two tenants sharing one platform, with different stores + themes.
INSERT INTO tenants (id, name, theme) VALUES
  ('t_acme', 'Acme', '{"color":"#c0392b"}'),
  ('t_beta', 'Beta', '{"color":"#2471a3"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO domains (host, tenant_id, verified) VALUES
  ('acme.localhost', 't_acme', true),
  ('beta.localhost', 't_beta', true),
  ('acme.ratiodev.in', 't_acme', true),
  ('beta.ratiodev.in', 't_beta', true)
ON CONFLICT (host) DO NOTHING;

-- Page-builder pages — the sole storefront renderer. live_doc is a PageDoc served as-is by the
-- origin (getLive). Each store gets a home so it renders out of the box.
INSERT INTO pages (tenant_id, path, live_doc, revision) VALUES
  ('t_acme', '/', '{"path":"/","title":"Home","sections":[{"id":"hero","type":"hero","data":{"hero":{"heading":"Acme","sub":"Welcome to Acme"}}}]}', 1),
  ('t_beta', '/', '{"path":"/","title":"Home","sections":[{"id":"hero","type":"hero","data":{"hero":{"heading":"Beta","sub":"Welcome to Beta"}}}]}', 1)
ON CONFLICT (tenant_id, path) DO NOTHING;

-- Legacy content-model routes (retained until the routes-table teardown; no longer rendered).
INSERT INTO routes (tenant_id, path, page_type, page_config) VALUES
  ('t_acme', '/',                  'home',    '{"title":"Acme Home","body":"Welcome to Acme"}'),
  ('t_acme', '/products/red-shoe', 'product', '{"title":"Red Shoe","price":"Rs 1999"}'),
  ('t_beta', '/',                  'home',    '{"title":"Beta Home","body":"Welcome to Beta"}'),
  ('t_beta', '/about',             'page',    '{"title":"About Beta","body":"We are Beta"}')
ON CONFLICT (tenant_id, path) DO NOTHING;
