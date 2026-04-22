import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SplitHistoryItem, SplitConfig } from '../../../types/storyboardSplit'
import { DEFAULT_SPLIT_CONFIG } from '../../../types/storyboardSplit'

const MAX_HISTORY = 50
const MAX_THUMBNAIL_BYTES = 25000

type GridCols = 2 | 3 | 4 | 6

interface SplitPersistState {
  history: SplitHistoryItem[]
  defaultConfig: SplitConfig
  gridCols: GridCols
  historyDrawerOpen: boolean

  pushHistory: (item: SplitHistoryItem) => void
  removeHistory: (id: string) => void
  clearHistory: () => void
  updateDefaultConfig: (config: SplitConfig) => void
  setGridCols: (n: GridCols) => void
  toggleHistoryDrawer: () => void
}

export const useSplitPersistStore = create<SplitPersistState>()(
  persist(
    (set) => ({
      history: [],
      defaultConfig: { ...DEFAULT_SPLIT_CONFIG },
      gridCols: 3 as GridCols,
      historyDrawerOpen: false,

      pushHistory: (item) =>
        set((s) => {
          let thumb = item.thumbnailDataUrl
          if (thumb && thumb.length > MAX_THUMBNAIL_BYTES) {
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

      setGridCols: (n) => set({ gridCols: n }),

      toggleHistoryDrawer: () => set((s) => ({ historyDrawerOpen: !s.historyDrawerOpen })),
    }),
    {
      name: 'storyboard-split-storage',
      version: 2,
      migrate: (persisted: any, version: number) => {
        if (version < 2) {
          persisted.gridCols = persisted.gridCols ?? 3
          persisted.historyDrawerOpen = persisted.historyDrawerOpen ?? false
        }
        return persisted
      },
      partialize: (state) => ({
        history: state.history.slice(0, MAX_HISTORY),
        defaultConfig: state.defaultConfig,
        gridCols: state.gridCols,
        historyDrawerOpen: state.historyDrawerOpen,
      }),
    }
  )
)
