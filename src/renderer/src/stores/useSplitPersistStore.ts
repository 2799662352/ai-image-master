import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SplitHistoryItem, SplitConfig } from '../../../types/storyboardSplit'
import { DEFAULT_SPLIT_CONFIG } from '../../../types/storyboardSplit'

const MAX_HISTORY = 50
const MAX_THUMBNAIL_BYTES = 25000

interface SplitPersistState {
  history: SplitHistoryItem[]
  defaultConfig: SplitConfig

  pushHistory: (item: SplitHistoryItem) => void
  removeHistory: (id: string) => void
  clearHistory: () => void
  updateDefaultConfig: (config: SplitConfig) => void
}

export const useSplitPersistStore = create<SplitPersistState>()(
  persist(
    (set) => ({
      history: [],
      defaultConfig: { ...DEFAULT_SPLIT_CONFIG },

      pushHistory: (item) =>
        set((s) => {
          let thumb = item.thumbnailDataUrl
          if (thumb.length > MAX_THUMBNAIL_BYTES) {
            console.warn(`[SplitPersist] thumbnail too large (${thumb.length}), truncating`)
            thumb = ''
          }
          const updated = [{ ...item, thumbnailDataUrl: thumb }, ...s.history].slice(0, MAX_HISTORY)
          return { history: updated }
        }),

      removeHistory: (id) =>
        set((s) => ({ history: s.history.filter((h) => h.id !== id) })),

      clearHistory: () => set({ history: [] }),

      updateDefaultConfig: (config) => set({ defaultConfig: { ...config } }),
    }),
    {
      name: 'storyboard-split-storage',
      version: 1,
      partialize: (state) => ({
        history: state.history.slice(0, MAX_HISTORY),
        defaultConfig: state.defaultConfig,
      }),
    }
  )
)
