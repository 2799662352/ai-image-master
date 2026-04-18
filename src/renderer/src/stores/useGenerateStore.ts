import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

export interface GenerateState {
  prompt: string
  ratio: string
  generating: boolean
  resultUrls: string[]
  referenceImages: string[]
  error: string | null

  setPrompt: (v: string) => void
  setRatio: (v: string) => void
  addReferenceImage: (dataUrl: string) => void
  removeReferenceImage: (index: number) => void
  clearResults: () => void
  generate: (api: ApiActions, modelKey: string) => Promise<void>
}

export const initialState = {
  prompt: '',
  ratio: '1:1',
  generating: false,
  resultUrls: [] as string[],
  referenceImages: [] as string[],
  error: null as string | null,
}

export const useGenerateStore = create<GenerateState>((set, get) => ({
  ...initialState,

  setPrompt: (v) => set({ prompt: v }),
  setRatio: (v) => set({ ratio: v }),
  addReferenceImage: (dataUrl) => set((s) => ({ referenceImages: [...s.referenceImages, dataUrl] })),
  removeReferenceImage: (index) =>
    set((s) => ({
      referenceImages: s.referenceImages.filter((_, i) => i !== index),
    })),
  clearResults: () => set({ resultUrls: [], error: null }),

  generate: async (api, modelKey) => {
    set({ generating: true, error: null, resultUrls: [] })
    try {
      const { prompt, ratio, referenceImages } = get()
      const result = await api.generateImage({
        prompt,
        ratio,
        model: modelKey,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      })
      const urls = result.urls ?? result.images ?? []
      set({ resultUrls: urls, generating: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), generating: false })
    }
  },
}))
