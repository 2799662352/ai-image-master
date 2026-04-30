// Zustand `persist` middleware StateStorage adapter backed by `idb-keyval`.
// Used by stores whose payload exceeds localStorage's ~5 MB quota — for
// smart-erase, history posters (base64 jpeg ~10 KB each × 50) easily blow
// past the localStorage budget when combined with other persisted state.
//
// IMPORTANT: idb-keyval's get/set/del are async. Zustand's persist middleware
// supports async storage natively but stores remain populated with their
// initial state until the rehydration callback fires. Components reading
// hydrated values MUST gate via the store's `_hasHydrated` flag (see
// useErasePersistStore.ts).
//
// Reference: https://zustand.docs.pmnd.rs/integrations/persisting-store-data#how-can-i-check-if-my-store-has-been-hydrated

import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval'
import type { StateStorage } from 'zustand/middleware'

/**
 * Returns a StateStorage compatible with `createJSONStorage`. The wrapper
 * coerces the idb-keyval result to the `string | null` shape zustand expects;
 * any non-string stored value (shouldn't happen in normal use, but defensive)
 * resolves to null so persist sees a clean miss and falls back to defaults.
 */
export function createIdbStorage(): StateStorage {
  return {
    getItem: async (name: string): Promise<string | null> => {
      try {
        const value = await idbGet(name)
        return typeof value === 'string' ? value : null
      } catch (err) {
        // Quota exceeded, browser blocked, etc. — fail open with defaults.
        console.warn('[idbKeyValStore] getItem failed for', name, err)
        return null
      }
    },
    setItem: async (name: string, value: string): Promise<void> => {
      try {
        await idbSet(name, value)
      } catch (err) {
        console.warn('[idbKeyValStore] setItem failed for', name, err)
      }
    },
    removeItem: async (name: string): Promise<void> => {
      try {
        await idbDel(name)
      } catch (err) {
        console.warn('[idbKeyValStore] removeItem failed for', name, err)
      }
    },
  }
}
