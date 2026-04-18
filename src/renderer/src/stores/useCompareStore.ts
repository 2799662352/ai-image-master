import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

export interface CompareState {
  leftModelKey: string | null
  rightModelKey: string | null
  prompt: string
  comparing: boolean
  leftResult: string | null
  rightResult: string | null
  error: string | null

  setLeftModel: (key: string | null) => void
  setRightModel: (key: string | null) => void
  setPrompt: (v: string) => void
  compare: (api: ApiActions) => Promise<void>
}

export const initialState = {
  leftModelKey: null as string | null,
  rightModelKey: null as string | null,
  prompt: '',
  comparing: false,
  leftResult: null as string | null,
  rightResult: null as string | null,
  error: null as string | null,
}

export const useCompareStore = create<CompareState>((set, get) => ({
  ...initialState,

  setLeftModel: (key) => set({ leftModelKey: key }),
  setRightModel: (key) => set({ rightModelKey: key }),
  setPrompt: (v) => set({ prompt: v }),

  compare: async (api) => {
    const { leftModelKey, rightModelKey, prompt } = get()
    if (!leftModelKey || !rightModelKey) return
    set({ comparing: true, leftResult: null, rightResult: null, error: null })

    const [leftSettled, rightSettled] = await Promise.allSettled([
      api.generateImage({ model: leftModelKey, prompt }),
      api.generateImage({ model: rightModelKey, prompt }),
    ])

    const leftUrl =
      leftSettled.status === 'fulfilled'
        ? (leftSettled.value.urls?.[0] ?? leftSettled.value.images?.[0] ?? null)
        : null
    const rightUrl =
      rightSettled.status === 'fulfilled'
        ? (rightSettled.value.urls?.[0] ?? rightSettled.value.images?.[0] ?? null)
        : null

    const error = !leftUrl && !rightUrl ? '两个模型均生成失败' : null
    set({ leftResult: leftUrl, rightResult: rightUrl, comparing: false, error })
  },
}))
