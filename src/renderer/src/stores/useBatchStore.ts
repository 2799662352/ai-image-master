import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

export interface BatchItem {
  id: string
  prompt: string
  status: 'pending' | 'generating' | 'done' | 'error'
  resultUrl?: string
  error?: string
}

export interface BatchState {
  items: BatchItem[]
  running: boolean

  addItem: (prompt: string) => void
  removeItem: (id: string) => void
  bulkAdd: (text: string) => void
  clearAll: () => void
  runBatch: (api: ApiActions, modelKey: string) => Promise<void>
}

export const initialState = {
  items: [] as BatchItem[],
  running: false,
}

export const useBatchStore = create<BatchState>((set, get) => ({
  ...initialState,

  addItem: (prompt) =>
    set((s) => ({
      items: [...s.items, { id: crypto.randomUUID(), prompt, status: 'pending' }],
    })),

  removeItem: (id) =>
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
    })),

  bulkAdd: (text) => {
    const lines = text.split('\n').filter((l) => l.trim())
    const newItems: BatchItem[] = lines.map((line) => ({
      id: crypto.randomUUID(),
      prompt: line.trim(),
      status: 'pending',
    }))
    set((s) => ({ items: [...s.items, ...newItems] }))
  },

  clearAll: () => set({ items: [] }),

  runBatch: async (api, modelKey) => {
    const pending = get().items.filter((i) => i.status === 'pending')
    if (pending.length === 0) return

    set({ running: true })

    for (const item of pending) {
      set((state) => ({
        items: state.items.map((i) =>
          i.id === item.id ? { ...i, status: 'generating' as const } : i
        ),
      }))

      try {
        const result = await api.generateImage({ prompt: item.prompt, model: modelKey })
        const url = result.urls?.[0] ?? result.images?.[0]
        set((state) => ({
          items: state.items.map((i) =>
            i.id === item.id ? { ...i, status: 'done' as const, resultUrl: url } : i
          ),
        }))
      } catch (err) {
        set((state) => ({
          items: state.items.map((i) =>
            i.id === item.id
              ? {
                  ...i,
                  status: 'error' as const,
                  error: err instanceof Error ? err.message : String(err),
                }
              : i
          ),
        }))
      }
    }

    set({ running: false })
  },
}))
