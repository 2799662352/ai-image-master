import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'
import { useTemplateStore } from '../react-app/stores/useTemplateStore'
import { composePromptWithTemplate } from '../react-app/constants/templates'

export interface GenerateState {
  prompt: string
  ratio: string
  /**
   * True when at least one in-flight generate call exists.
   * Derived from `inFlightCount > 0`. Kept as a discrete field for cheap
   * Zustand subscription + backward compat with existing tests/UI.
   */
  generating: boolean
  /** Number of concurrent in-flight generate() calls (≥ 0). */
  inFlightCount: number
  /**
   * Accumulated result URLs across all completed generations since the last
   * clearResults(). Allows the user to fire multiple generations concurrently
   * and see them stream in without losing earlier results.
   */
  resultUrls: string[]
  referenceImages: string[]
  /** Latest error message (overwritten on each failure). */
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
  inFlightCount: 0,
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
    // Snapshot form values at submit time so the user can keep typing the
    // next prompt while this one is in flight (matches BatchPage live-queue
    // semantics — no blocking guard, results stream back).
    const { prompt, ratio, referenceImages } = get()
    const templateKey = useTemplateStore.getState().getSelection('generate')
    const finalPrompt = composePromptWithTemplate(templateKey, prompt)
    const refsSnapshot = referenceImages.length > 0 ? [...referenceImages] : undefined

    set((s) => ({
      inFlightCount: s.inFlightCount + 1,
      generating: true,
      error: null,
    }))

    try {
      const result = await api.generateImage({
        prompt: finalPrompt,
        ratio,
        model: modelKey,
        referenceImages: refsSnapshot,
      })
      const urls = result.urls ?? result.images ?? []
      set((s) => {
        const nextCount = Math.max(0, s.inFlightCount - 1)
        return {
          resultUrls: [...s.resultUrls, ...urls],
          inFlightCount: nextCount,
          generating: nextCount > 0,
        }
      })
    } catch (err) {
      set((s) => {
        const nextCount = Math.max(0, s.inFlightCount - 1)
        return {
          error: err instanceof Error ? err.message : String(err),
          inFlightCount: nextCount,
          generating: nextCount > 0,
        }
      })
    }
  },
}))
