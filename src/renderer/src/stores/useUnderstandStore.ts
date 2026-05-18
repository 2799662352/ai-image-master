import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

export interface UnderstandState {
  imageUrl: string | null
  question: string
  analysisResult: string
  /** Derived: `inFlightCount > 0`. Kept as a discrete field for backward compat. */
  analyzing: boolean
  /** Number of concurrent in-flight analyze() calls. */
  inFlightCount: number
  /** Monotonically incremented submit id; only the latest call wins for result/error. */
  latestSubmitId: number
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
  inFlightCount: 0,
  latestSubmitId: 0,
  error: null as string | null,
}

export const useUnderstandStore = create<UnderstandState>((set, get) => ({
  ...initialState,

  setImageUrl: (url) => set({ imageUrl: url }),
  setQuestion: (q) => set({ question: q }),

  analyze: async (api) => {
    // Snapshot inputs so the user can keep editing while a slow analysis runs.
    const { imageUrl, question } = get()

    // Stamp this submit so out-of-order completions don't clobber a newer
    // result. Last-write-wins on the visible `analysisResult` / `error`.
    const submitId = get().latestSubmitId + 1
    set((s) => ({
      latestSubmitId: submitId,
      inFlightCount: s.inFlightCount + 1,
      analyzing: true,
      error: null,
      // Note: we deliberately do NOT clear analysisResult here, so the previous
      // answer stays visible while a new one is in flight (matches the user's
      // expectation: "don't block me waiting for the current call").
    }))

    try {
      const result = await api.understandImage({
        images: [imageUrl!],
        prompt: question || undefined,
      })
      set((s) => {
        const nextCount = Math.max(0, s.inFlightCount - 1)
        // Only the most recent submit overwrites the visible result.
        const isLatest = submitId === s.latestSubmitId
        return {
          analysisResult: isLatest ? (result.content ?? '') : s.analysisResult,
          inFlightCount: nextCount,
          analyzing: nextCount > 0,
        }
      })
    } catch (err) {
      set((s) => {
        const nextCount = Math.max(0, s.inFlightCount - 1)
        const isLatest = submitId === s.latestSubmitId
        return {
          error: isLatest
            ? (err instanceof Error ? err.message : String(err))
            : s.error,
          inFlightCount: nextCount,
          analyzing: nextCount > 0,
        }
      })
    }
  },
}))
