import type { BreadcrumbItem } from './types';

// Product breadcrumb trail: Home → (collection, humanised from the handle, for a nested
// /collections/:c/products/:p route) → product. Mirrors storefront-2.0 buildBreadcrumbs.
export function productBreadcrumbs(
  siteUrl: string,
  path: string,
  productName: string
): BreadcrumbItem[] {
  const base = siteUrl.replace(/\/$/, '');
  const crumbs: BreadcrumbItem[] = [{ name: 'Home', url: base }];
  const collectionMatch = path.match(/\/collections\/([^/]+)\//);
  if (collectionMatch) {
    const handle = collectionMatch[1];
    const name = handle
      .split('-')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ');
    crumbs.push({ name, url: `${base}/collections/${handle}` });
  }
  crumbs.push({ name: productName, url: `${base}${path}` });
  return crumbs;
}

// Collection breadcrumb trail: Home → collection.
export function collectionBreadcrumbs(
  siteUrl: string,
  path: string,
  collectionName: string
): BreadcrumbItem[] {
  const base = siteUrl.replace(/\/$/, '');
  return [
    { name: 'Home', url: base },
    { name: collectionName, url: `${base}${path}` },
  ];
}
