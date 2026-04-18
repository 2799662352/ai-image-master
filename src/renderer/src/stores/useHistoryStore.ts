import { create } from 'zustand'
import type { HistoryItem, HistoryActions } from '../hooks/useHistory'

export interface HistoryState {
  items: HistoryItem[]
  searchQuery: string
  error: string | null

  setSearchQuery: (q: string) => void
  loadHistory: (history: HistoryActions) => void
  deleteItem: (id: number, history: HistoryActions) => void
}

export const initialState = {
  items: [] as HistoryItem[],
  searchQuery: '',
  error: null as string | null,
}

export const useHistoryStore = create<HistoryState>((set) => ({
  ...initialState,

  setSearchQuery: (q) => set({ searchQuery: q }),

  loadHistory: (history) => {
    try {
      const items = history.getAll()
      set({ items, error: null })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  deleteItem: (id, history) => {
    try {
      history.remove(id)
      set((s) => ({ items: s.items.filter((i) => i.id !== id), error: null }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },
}))
