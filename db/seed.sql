-- Two tenants sharing one platform, with different stores + themes.
INSERT INTO tenants (id, name, theme) VALUES
  ('t_acme', 'Acme', '{"color":"#c0392b"}'),
  ('t_beta', 'Beta', '{"color":"#2471a3"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO domains (host, tenant_id) VALUES
  ('acme.localhost', 't_acme'),
  ('beta.localhost', 't_beta')
ON CONFLICT (host) DO NOTHING;

INSERT INTO routes (tenant_id, path, page_type, page_config) VALUES
  ('t_acme', '/',                  'home',    '{"title":"Acme Home","body":"Welcome to Acme"}'),
  ('t_acme', '/products/red-shoe', 'product', '{"title":"Red Shoe","price":"Rs 1999"}'),
  ('t_beta', '/',                  'home',    '{"title":"Beta Home","body":"Welcome to Beta"}'),
  ('t_beta', '/about',             'page',    '{"title":"About Beta","body":"We are Beta"}')
ON CONFLICT (tenant_id, path) DO NOTHING;
