import { create } from 'zustand'

export interface ModelInfo {
  name: string
  capabilities?: Record<string, unknown>
  [key: string]: unknown
}

interface ModelState {
  currentModelKey: string
  models: Record<string, ModelInfo>
  setModels: (models: Record<string, ModelInfo>) => void
  switchModel: (key: string) => void
}

export const useModelStore = create<ModelState>()((set) => ({
  currentModelKey: localStorage.getItem('current_model') || '',
  models: {},
  setModels: (models) => set({ models }),
  switchModel: (key) => set({ currentModelKey: key }),
}))

// 终极同步: 监听 ApiService.setModel() 派发的 CustomEvent
// 不依赖任何回调注册 / 单例初始化顺序 — 只要 model 在 ApiService 里被 set,React 就会同步
if (typeof window !== 'undefined') {
  window.addEventListener('model-changed', ((e: CustomEvent<{ modelKey: string }>) => {
    useModelStore.getState().switchModel(e.detail.modelKey)
  }) as EventListener)
}
