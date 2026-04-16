import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ModelInfo {
  name: string
  capabilities: Record<string, unknown>
  [key: string]: unknown
}

interface ModelState {
  currentModelKey: string
  models: Record<string, ModelInfo>
  setModels: (models: Record<string, ModelInfo>) => void
  switchModel: (key: string) => void
}

export const useModelStore = create<ModelState>()(
  persist(
    (set, get) => ({
      currentModelKey: '',
      models: {},
      setModels: (models) => set({ models }),
      switchModel: (key) => {
        if (get().models[key] || key === '') {
          set({ currentModelKey: key })
        }
      },
    }),
    { name: 'model-store' }
  )
)
