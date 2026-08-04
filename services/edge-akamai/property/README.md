# Property Manager rules (Akamai)

On Cloudflare, caching + serve-stale are **code** (`caches.default` in the Worker). On Akamai they
are **declarative Property Manager config** — so this folder holds the rule spec, not TypeScript.

The rules to configure (mirror what the Cloudflare edge does in code — see S3/ADR-008):

| Behaviour                                                               | Property Manager rule                                                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Cache tiers (T0 versioned / T1 short+purge / T2 volatile / T3 no-store) | Caching + TTL per page-class, keyed on the origin's Cache-Control                                   |
| Serve-stale on origin down/slow (T1)                                    | "Cache HTTP error responses" + serve-stale on error + an origin connect/read timeout                |
| Exact purge on change (S1)                                              | Cache tags via `Edge-Cache-Tag` + Fast Purge by tag                                                 |
| Private origin                                                          | **Site Shield** (lock origin to Akamai IPs) + forward the `x-edge-auth` header                      |
| Security headers                                                        | CSP / X-Content-Type-Options / Referrer-Policy on storefront responses (edge-core `STOREFRONT_CSP`) |

Export the finished rule tree here (JSON) once built in OFCE-476, so it's versioned with the code.
