import { create } from 'zustand'
import { normalizeModelKey } from '../utils/modelKeyAliases'

export interface ModelInfo {
  name: string
  capabilities?: Record<string, unknown>
  sizeStrategy?: string
  [key: string]: unknown
}

interface ModelState {
  currentModelKey: string
  models: Record<string, ModelInfo>
  setModels: (models: Record<string, ModelInfo>) => void
  switchModel: (key: string) => void
}

export const useModelStore = create<ModelState>()((set, get) => ({
  currentModelKey: normalizeModelKey(localStorage.getItem('current_model') || ''),
  models: {},
  setModels: (models) => set({ models }),
  // 唯一切换入口(选择器 / 历史回灌 / 重编辑 / ServiceBridge 桥都走这里)。
  // 之前只更新 React store,不回推旧的 ApiService 单例 → 模型脑裂:
  // 实际请求与 getCurrentModel()(BatchPage 旧 modelConfig、下载、旧页)对不上,
  // 且切换不落 localStorage,刷新就回退。现在一次切换同步三件事:
  //   ① React store(UI 即时反应)
  //   ② ApiService.currentModel(请求兜底 + 旧消费方)
  //   ③ localStorage(刷新保留)—— 后两者由幂等的 setModel 完成。
  switchModel: (key) => {
    const resolved = normalizeModelKey(key)
    if (!get().models[resolved]) {
      set({ currentModelKey: '' })
      return
    }
    if (get().currentModelKey !== resolved) set({ currentModelKey: resolved })
    // setModel 幂等且对 model-changed 回环做了早返回守卫,这里再调一次是安全的:
    // 它会持久化并(若值有变)派发 model-changed,事件回到下面的监听器再次进入
    // switchModel 时,store 已是新值(idempotent),setModel 也因相等而早返回,环就此断开。
    const api = (typeof window !== 'undefined'
      ? (window as unknown as { aiImageAPI?: { setModel?: (k: string) => boolean } }).aiImageAPI
      : undefined)
    api?.setModel?.(resolved)
  },
}))

// 终极同步: 监听 ApiService.setModel() 派发的 CustomEvent
// 不依赖任何回调注册 / 单例初始化顺序 — 只要 model 在 ApiService 里被 set,React 就会同步
if (typeof window !== 'undefined') {
  window.addEventListener('model-changed', ((e: CustomEvent<{ modelKey: string }>) => {
    useModelStore.getState().switchModel(e.detail.modelKey)
  }) as EventListener)
}
