import { create, type StateCreator } from 'zustand'

// --- Types ---

export interface DirectorReferenceImage {
  data: string
  mimeType: string
  name: string
}

export type LayoutType = '6grid' | '4grid' | '2closeup' | '9grid'
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

interface GenerationSlice {
  isGenerating: boolean
  isProcessingFiles: boolean
  generatedResults: GeneratedResult[]
  lastAnalysisResult: string | null
  lastCharacterAnchor: string | null
  setIsGenerating: (val: boolean) => void
  setIsProcessingFiles: (val: boolean) => void
  setGeneratedResults: (val: GeneratedResult[]) => void
  setLastAnalysisResult: (val: string | null) => void
  setLastCharacterAnchor: (val: string | null) => void
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
  'isGenerating' | 'isProcessingFiles' | 'generatedResults' | 'lastAnalysisResult' | 'lastCharacterAnchor'
> = {
  isGenerating: false,
  isProcessingFiles: false,
  generatedResults: [],
  lastAnalysisResult: null,
  lastCharacterAnchor: null,
}

const initialConfigState: Pick<
  ConfigSlice,
  'currentLayout' | 'currentTemplate' | 'currentMode' | 'currentRatio' | 'currentResolution' | 'sceneDescription' | 'visionModel' | 'imageModel' | 'imageCount' | 'skipVerify'
> = {
  currentLayout: '6grid',
  currentTemplate: null,
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
