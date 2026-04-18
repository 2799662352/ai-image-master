import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

export interface UnderstandState {
  imageUrl: string | null
  question: string
  analysisResult: string
  analyzing: boolean
  error: string | null

  setImageUrl: (url: string | null) => void
  setQuestion: (q: string) => void
  analyze: (api: ApiActions) => Promise<void>
}

export const initialState = {
  imageUrl: null as string | null,
  question: '',
  analysisResult: '',
  analyzing: false,
  error: null as string | null,
}

export const useUnderstandStore = create<UnderstandState>((set, get) => ({
  ...initialState,

  setImageUrl: (url) => set({ imageUrl: url }),
  setQuestion: (q) => set({ question: q }),

  analyze: async (api) => {
    set({ analyzing: true, error: null, analysisResult: '' })
    try {
      const { imageUrl, question } = get()
      const result = await api.understandImage({
        images: [imageUrl!],
        prompt: question || undefined,
      })
      set({ analysisResult: result.content ?? '', analyzing: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), analyzing: false })
    }
  },
}))
