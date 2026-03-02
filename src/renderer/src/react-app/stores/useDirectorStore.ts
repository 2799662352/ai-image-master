import { create, type StateCreator } from 'zustand'

// --- Types ---

export interface DirectorReferenceImage {
  data: string
  mimeType: string
  name: string
}

export type LayoutType = '6grid' | '4grid' | '2closeup' | '9grid' | '16grid' | '25grid'
export type GenerationMode = 'single' | 'multi'

export interface GeneratedResult {
  url: string
  prompt: string
  timestamp: number
  [key: string]: unknown
}

// --- Slice interfaces ---

interface ImageSlice {
  referenceImages: DirectorReferenceImage[]
  addReferenceImage: (image: DirectorReferenceImage) => void
  removeReferenceImage: (index: number) => void
  clearReferenceImages: () => void
}

type ViewState = 'idle' | 'generating' | 'results'

interface ProgressData {
  pass: number
  totalPasses: number
  label: string
  status: 'running' | 'completed' | 'retrying' | 'failed'
  elapsed?: number
  passData?: unknown
  data?: unknown
}

type PassStatus = 'pending' | 'running' | 'completed' | 'retrying' | 'failed'

interface GenerationSlice {
  isGenerating: boolean
  isProcessingFiles: boolean
  generatedResults: GeneratedResult[]
  lastAnalysisResult: string | null
  lastCharacterAnchor: string | null
  viewState: ViewState
  currentProgress: ProgressData | null
  passStatuses: PassStatus[]
  passCards: unknown[]
  progressPercentage: number
  setIsGenerating: (val: boolean) => void
  setIsProcessingFiles: (val: boolean) => void
  setGeneratedResults: (val: GeneratedResult[]) => void
  setLastAnalysisResult: (val: string | null) => void
  setLastCharacterAnchor: (val: string | null) => void
  setViewState: (val: ViewState) => void
  setCurrentProgress: (val: ProgressData | null) => void
  pushProgress: (progress: ProgressData) => void
  resetProgress: () => void
}

interface ConfigSlice {
  currentLayout: LayoutType
  currentTemplate: string | null
  currentMode: GenerationMode
  currentRatio: string
  currentResolution: string
  sceneDescription: string
  multiSceneText: string
  visionModel: string
  imageModel: string
  imageCount: number
  skipVerify: boolean
  setLayout: (val: LayoutType) => void
  setTemplate: (val: string | null) => void
  setMode: (val: GenerationMode) => void
  setRatio: (val: string) => void
  setResolution: (val: string) => void
  setSceneDescription: (val: string) => void
  setMultiSceneText: (val: string) => void
  setVisionModel: (val: string) => void
  setImageModel: (val: string) => void
  setImageCount: (val: number) => void
  setSkipVerify: (val: boolean) => void
}

interface ResetSlice {
  reset: () => void
}

export type DirectorStore = ImageSlice & GenerationSlice & ConfigSlice & ResetSlice

// --- Initial values ---

const MAX_REFERENCE_IMAGES = 8

const initialImageState: Pick<ImageSlice, 'referenceImages'> = {
  referenceImages: [],
}

const initialGenerationState: Pick<
  GenerationSlice,
  'isGenerating' | 'isProcessingFiles' | 'generatedResults' | 'lastAnalysisResult' | 'lastCharacterAnchor' | 'viewState' | 'currentProgress' | 'passStatuses' | 'passCards' | 'progressPercentage'
> = {
  isGenerating: false,
  isProcessingFiles: false,
  generatedResults: [],
  lastAnalysisResult: null,
  lastCharacterAnchor: null,
  viewState: 'idle',
  currentProgress: null,
  passStatuses: [],
  passCards: [],
  progressPercentage: 0,
}

const initialConfigState: Pick<
  ConfigSlice,
  'currentLayout' | 'currentTemplate' | 'currentMode' | 'currentRatio' | 'currentResolution' | 'sceneDescription' | 'multiSceneText' | 'visionModel' | 'imageModel' | 'imageCount' | 'skipVerify'
> = {
  currentLayout: '6grid',
  currentTemplate: 'cinematic',
  currentMode: 'single',
  currentRatio: '3:2',
  currentResolution: '2K',
  sceneDescription: '',
  multiSceneText: '',
  visionModel: '',
  imageModel: '',
  imageCount: 1,
  skipVerify: false,
}

// --- Slice creators ---

const createImageSlice: StateCreator<DirectorStore, [], [], ImageSlice> = (set) => ({
  ...initialImageState,
  addReferenceImage: (image) =>
    set((state) => {
      if (state.referenceImages.length >= MAX_REFERENCE_IMAGES) return state
      return { referenceImages: [...state.referenceImages, image] }
    }),
  removeReferenceImage: (index) =>
    set((state) => ({
      referenceImages: state.referenceImages.filter((_, i) => i !== index),
    })),
  clearReferenceImages: () => set({ referenceImages: [] }),
})

const createGenerationSlice: StateCreator<DirectorStore, [], [], GenerationSlice> = (set) => ({
  ...initialGenerationState,
  setIsGenerating: (val) => set({ isGenerating: val }),
  setIsProcessingFiles: (val) => set({ isProcessingFiles: val }),
  setGeneratedResults: (val) => set({ generatedResults: val }),
  setLastAnalysisResult: (val) => set({ lastAnalysisResult: val }),
  setLastCharacterAnchor: (val) => set({ lastCharacterAnchor: val }),
  setViewState: (val) => set({ viewState: val }),
  setCurrentProgress: (val) => set({ currentProgress: val }),
  pushProgress: (progress) => set((state) => {
    const totalPasses = progress.totalPasses || 5
    const statuses = [...state.passStatuses]
    while (statuses.length < totalPasses) statuses.push('pending')
    for (let i = 0; i < progress.pass - 1; i++) {
      if (i < statuses.length && (statuses[i] === 'pending' || statuses[i] === 'running')) {
        statuses[i] = 'completed'
      }
    }
    const idx = progress.pass - 1
    if (idx >= 0 && idx < statuses.length) {
      statuses[idx] = progress.status === 'completed' ? 'completed'
        : progress.status === 'retrying' ? 'retrying'
        : progress.status === 'failed' ? 'failed'
        : 'running'
    }

    const base = ((progress.pass - 1) / totalPasses) * 100
    const stepBonus = progress.status === 'completed'
      ? (1 / totalPasses) * 100
      : (0.5 / totalPasses) * 100
    const pct = Math.min(Math.round(base + stepBonus), 100)

    let cards = state.passCards
    if (progress.passData) {
      const pd = progress.passData as { pass: number }
      const exists = (state.passCards as Array<{ pass: number }>).some((c) => c.pass === pd.pass)
      if (!exists) cards = [...state.passCards, progress.passData]
    }

    return {
      currentProgress: progress,
      passStatuses: statuses,
      passCards: cards,
      progressPercentage: pct,
    }
  }),
  resetProgress: () => set({
    currentProgress: null,
    passStatuses: [],
    passCards: [],
    progressPercentage: 0,
  }),
})

const createConfigSlice: StateCreator<DirectorStore, [], [], ConfigSlice> = (set) => ({
  ...initialConfigState,
  setLayout: (val) => set({ currentLayout: val }),
  setTemplate: (val) => set({ currentTemplate: val }),
  setMode: (val) => set({ currentMode: val }),
  setRatio: (val) => set({ currentRatio: val }),
  setResolution: (val) => set({ currentResolution: val }),
  setSceneDescription: (val) => set({ sceneDescription: val }),
  setMultiSceneText: (val) => set({ multiSceneText: val }),
  setVisionModel: (val) => set({ visionModel: val }),
  setImageModel: (val) => set({ imageModel: val }),
  setImageCount: (val) => set({ imageCount: val }),
  setSkipVerify: (val) => set({ skipVerify: val }),
})

const createResetSlice: StateCreator<DirectorStore, [], [], ResetSlice> = (set) => ({
  reset: () =>
    set({
      ...initialImageState,
      ...initialGenerationState,
      ...initialConfigState,
    }),
})

// --- Store ---

export const useDirectorStore = create<DirectorStore>()((...a) => ({
  ...createImageSlice(...a),
  ...createGenerationSlice(...a),
  ...createConfigSlice(...a),
  ...createResetSlice(...a),
}))
