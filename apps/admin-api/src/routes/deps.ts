import type { Context } from 'hono';
import type { PageBuilder, PgPageStore, ThemeFiles, TenantCommerce } from '@ratio/builder-core';
import { ThemeStore as BundleThemeStore } from '@ratio/builder-core';
import type { IdempotencyStore } from '../middleware/idempotency';

export type Vars = { Variables: { userId: string; scope?: string[]; auditTenant?: string } };

// Values built inside createApp (or shared module singletons) that the per-domain route groups
// close over. Anything that is a plain module import (guards from ./auth, package helpers, node
// builtins) is imported directly by the route module instead of threaded through here.
export interface RouteDeps {
  themes: BundleThemeStore | null;
  mainThemeId: (tenantId: string) => string;
  ensureStoreTheme: (tenantId: string) => Promise<void>;
  publishStoreThemeOnOnboard: (tenantId: string, baseThemeId?: string) => Promise<void>;
  prewarmStore: (tenantId: string) => Promise<void>;
  assertThemeInStore: (themeId: string, storeId: string) => Promise<void>;
  identityCompile: (s: ThemeFiles) => ThemeFiles;
  bundle503: (c: Context<Vars>) => Response;
  purgeEdgeTags: (tags: string[]) => Promise<void>;
  purgeStoreUrls: (id: string, paths: string[]) => Promise<boolean | null>;
  renderThemePreview: (
    files: ThemeFiles,
    page: string,
    tenantId: string,
    commerce?: TenantCommerce | null,
    theme?: unknown,
    siteName?: string
  ) => Promise<{ html: string; tags: string[]; sampleData: boolean }>;
  pbStore: PgPageStore;
  pageBuilder: PageBuilder;
  sectionCatalog: () => unknown[];
  viaSelf: typeof fetch;
  idem: IdempotencyStore;
  readiness: () => Promise<boolean>;
}
