import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createIdbStorage } from '../utils/idbKeyValStore'
import type { EraseHistoryItem, EraseConfig } from '../../../types/smartErase'
import { DEFAULT_ERASE_CONFIG } from '../../../types/smartErase'

const MAX_HISTORY = 50
const MAX_POSTER_BYTES = 50_000 // ~50 KB; ffmpeg-generated thumbs are usually ~10 KB

interface EraseDrawer {
  open: boolean
}

interface EraseDefaults {
  config: EraseConfig
}

interface EraseHistoryActions {
  pushHistory: (item: EraseHistoryItem) => void
  removeHistory: (id: string) => void
  clearHistory: () => void
}

interface EraseConfigActions {
  updateDefaultConfig: (config: EraseConfig) => void
}

interface EraseDrawerActions {
  toggleHistoryDrawer: () => void
}

interface EraseHydrationActions {
  /** Internal: flipped to true by onRehydrateStorage when idb finishes loading. */
  setHasHydrated: (hydrated: boolean) => void
}

interface EraseAccess
  extends EraseHistoryActions,
    EraseConfigActions,
    EraseDrawerActions,
    EraseHydrationActions {
  history: EraseHistoryItem[]
  defaultConfig: EraseConfig
  drawer: EraseDrawer
  /**
   * Async storage requires a hydration gate. UI components reading `history`
   * or `defaultConfig` MUST check this before showing data — otherwise the
   * first render shows schema defaults (empty array, DEFAULT_ERASE_CONFIG)
   * which can race with the user clicking "submit" and silently losing a
   * persisted custom definitionId.
   *
   * Pattern (see plan §Task 8):
   *   const hydrated = useErasePersistStore(s => s._hasHydrated)
   *   if (!hydrated) return <LoadingPlaceholder />
   */
  _hasHydrated: boolean
}

export const useErasePersistStore = create<EraseAccess>()(
  persist(
    (set) => ({
      history: [],
      defaultConfig: { ...DEFAULT_ERASE_CONFIG } as EraseDefaults['config'],
      drawer: { open: false },
      _hasHydrated: false,

      pushHistory: (item) =>
        set((s) => {
          // Defensive: a poster larger than MAX_POSTER_BYTES would push the
          // serialised state above 1 MB; idb tolerates this but we'd rather
          // preserve the URL + filename and lose the thumbnail than carry
          // a megabyte through every load.
          let poster = item.posterDataUrl ?? ''
          if (poster && poster.length > MAX_POSTER_BYTES) {
            console.warn(
              '[useErasePersistStore] poster too large (',
              poster.length,
              'bytes) — dropping',
            )
            poster = ''
          }
          const updated = [{ ...item, posterDataUrl: poster }, ...s.history].slice(0, MAX_HISTORY)
          return { history: updated }
        }),

      removeHistory: (id) =>
        set((s) => ({ history: s.history.filter((h) => h.id !== id) })),

      clearHistory: () => set({ history: [] }),

      updateDefaultConfig: (config) =>
        set({ defaultConfig: { ...config } }),

      toggleHistoryDrawer: () =>
        set((s) => ({ drawer: { open: !s.drawer.open } })),

      setHasHydrated: (hydrated) => set({ _hasHydrated: hydrated }),
    }),
    {
      name: 'smart-erase-storage',
      version: 2,
      storage: createJSONStorage(() => createIdbStorage()),
      partialize: (state) => ({
        history: state.history.slice(0, MAX_HISTORY),
        defaultConfig: state.defaultConfig,
        drawer: state.drawer,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.warn('[useErasePersistStore] hydration failed:', error)
        }
        // Always flip hydration true even on error so the UI unblocks rather
        // than spinning forever; defaults remain in place per partialize miss.
        state?.setHasHydrated(true)
      },
    },
  ),
)
