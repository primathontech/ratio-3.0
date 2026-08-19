import { createContext, useContext } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { Api, Store } from './api';
import { LOCAL_EDGE_PORT } from './constants';

export interface Me {
  userId: string;
  isPlatformAdmin: boolean;
  isLocal?: boolean;
}

// App-wide data available to every route: the store list, the signed-in identity, and helpers to
// reload / open the create-store dialog. Fetched once by AuthedRoutes and provided here.
export interface StoreData {
  api: Api;
  stores: Store[];
  me: Me | null;
  reload: () => void;
  openCreate: () => void;
}

const Ctx = createContext<StoreData | null>(null);
export const StoreDataProvider = Ctx.Provider;

export function useStoreData(): StoreData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStoreData must be used within StoreDataProvider');
  return v;
}

// The per-store context the MerchantLayout hands to its nested route (the resolved store).
export interface MerchantCtx {
  api: Api;
  store: Store;
}
export function useMerchant(): MerchantCtx {
  return useOutletContext<MerchantCtx>();
}

// The URL identifier for a store: its internal id — stable across domain changes, always present,
// and URL-safe. So /stores/t_acme_1a2b/themes, not /stores/acme.ratiodev.in/themes. resolveStore
// still accepts an old domain-based URL, so existing links keep working.
export function storeSlug(store: { id: string }): string {
  return store.id;
}

// The live storefront URL to open in a browser. In local dev (RATIO_LOCAL / me.isLocal) the store
// is reachable at its <label>.localhost alias on the local edge; in production it's the real domain
// over https. Returns null when the store has no matching host yet.
export function storefrontUrl(store: Store, isLocal: boolean): string | null {
  const hosts = [...(store.hosts ?? []), store.host].filter(Boolean) as string[];
  if (isLocal) {
    const local = hosts.find((h) => h.endsWith('.localhost'));
    return local ? `http://${local}:${LOCAL_EDGE_PORT}` : null;
  }
  const real = hosts.find((h) => !h.endsWith('.localhost'));
  return real ? `https://${real}` : null;
}

// The host to SHOW for the storefront (address-bar text, "live on …" labels) — the same target the
// "View store" link opens, minus the scheme. In local dev that's the .localhost:8080 alias, so the
// displayed host matches where the link actually goes. Null when there's no reachable host.
export function storefrontHost(store: Store, isLocal: boolean): string | null {
  return storefrontUrl(store, isLocal)?.replace(/^https?:\/\//, '') ?? null;
}
export function resolveStore(stores: Store[], param: string | undefined): Store | undefined {
  if (!param) return undefined;
  return stores.find((s) => s.host === param || s.hosts?.includes(param) || s.id === param);
}
