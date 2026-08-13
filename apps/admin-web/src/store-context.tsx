import { createContext, useContext } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { Api, Store } from './api';

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

// The per-store context the MerchantLayout hands to its nested route (the resolved :storeId store).
export interface MerchantCtx {
  api: Api;
  store: Store;
}
export function useMerchant(): MerchantCtx {
  return useOutletContext<MerchantCtx>();
}
