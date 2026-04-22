import { create, type StateCreator } from 'zustand'

// --- Types ---

export interface DirectorReferenceImage {
  data: string
  mimeType: string
  name: string
  fileSize?: number
  compressed?: boolean
}

export type LayoutType = '6grid' | '4grid' | '2closeup' | '9grid' | '16grid' | '25grid'
export type LayoutOrientation = 'landscape' | 'portrait'
export type GenerationMode = 'single' | 'multi'
export type VisionDetail = 'low' | 'high' | 'auto'
export type VisionDetailPreset = 'speed' | 'quality' | 'balanced'
export type VisionDetailPresetState = VisionDetailPreset | 'custom'

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

export type GenerationStatus = 'idle' | 'running' | 'paused'

interface GenerationSlice {
  isGenerating: boolean
  generationStatus: GenerationStatus
  isProcessingFiles: boolean
  generatedResults: GeneratedResult[]
  lastAnalysisResult: string | null
  lastCharacterAnchor: string | null
  lastPipelineState: Record<string, unknown> | null
  viewState: ViewState
  currentProgress: ProgressData | null
  passStatuses: PassStatus[]
  passCards: unknown[]
  progressPercentage: number
  regenerateCount: number
  setIsGenerating: (val: boolean) => void
  setGenerationStatus: (status: GenerationStatus) => void
  setIsProcessingFiles: (val: boolean) => void
  setGeneratedResults: (val: GeneratedResult[] | ((prev: GeneratedResult[]) => GeneratedResult[])) => void
  setLastAnalysisResult: (val: string | null) => void
  setLastCharacterAnchor: (val: string | null) => void
  setLastPipelineState: (val: Record<string, unknown> | null) => void
  setViewState: (val: ViewState) => void
  setCurrentProgress: (val: ProgressData | null) => void
  pushProgress: (progress: ProgressData) => void
  resetProgress: () => void
  setRegenerateCount: (val: number) => void
}

interface ConfigSlice {
  currentLayout: LayoutType
  currentLayoutOrientation: LayoutOrientation
  isLayoutOrientationAuto: boolean
  currentSemanticOrientation: LayoutOrientation
  isSemanticOrientationAuto: boolean
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
  skipTaskPlanning: boolean
  skipAnalyzeScene: boolean
  skipCharacterAnchors: boolean
  enableCreativePreplanner: boolean
  scoreThreshold: number
  visionDetailTaskPlanning: VisionDetail
  visionDetailAnalyzeScene: VisionDetail
  visionDetailCharacterAnchors: VisionDetail
  visionDetailDesignAssemble: VisionDetail
  visionDetailVerifyConsistency: VisionDetail
  setLayout: (val: LayoutType) => void
  setLayoutOrientation: (val: LayoutOrientation) => void
  setLayoutOrientationAuto: (val: boolean) => void
  setSemanticOrientation: (val: LayoutOrientation) => void
  setSemanticOrientationAuto: (val: boolean) => void
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
  setSkipTaskPlanning: (val: boolean) => void
  setSkipAnalyzeScene: (val: boolean) => void
  setSkipCharacterAnchors: (val: boolean) => void
  setEnableCreativePreplanner: (val: boolean) => void
  setScoreThreshold: (val: number) => void
  setVisionDetailTaskPlanning: (val: VisionDetail) => void
  setVisionDetailAnalyzeScene: (val: VisionDetail) => void
  setVisionDetailCharacterAnchors: (val: VisionDetail) => void
  setVisionDetailDesignAssemble: (val: VisionDetail) => void
  setVisionDetailVerifyConsistency: (val: VisionDetail) => void
  applyVisionDetailPreset: (preset: VisionDetailPreset) => void
}

interface ResetSlice {
  reset: () => void
}

export type DirectorStore = ImageSlice & GenerationSlice & ConfigSlice & ResetSlice

// --- Initial values ---

const MAX_REFERENCE_IMAGES = 8
const DEFAULT_SCORE_THRESHOLD = 6
const SCORE_THRESHOLD_STORAGE_KEY = 'director.score-threshold.v1'
const DIRECTOR_VISION_MODEL_STORAGE_KEY = 'director.vision-model.v1'
const DIRECTOR_RATIO_STORAGE_KEY = 'director.ratio.v1'
const DIRECTOR_LAYOUT_ORIENTATION_STORAGE_KEY = 'director.layout-orientation.v1'
const DIRECTOR_LAYOUT_ORIENTATION_AUTO_STORAGE_KEY = 'director.layout-orientation-auto.v1'
const DIRECTOR_SEMANTIC_ORIENTATION_STORAGE_KEY = 'director.semantic-orientation.v1'
const DIRECTOR_SEMANTIC_ORIENTATION_AUTO_STORAGE_KEY = 'director.semantic-orientation-auto.v1'
const DIRECTOR_VISION_DETAIL_TASK_PLANNING_STORAGE_KEY = 'director.vision-detail.task-planning.v1'
const DIRECTOR_SKIP_TASK_PLANNING_STORAGE_KEY = 'director.skip-task-planning.v1'
const DIRECTOR_SKIP_ANALYZE_SCENE_STORAGE_KEY = 'director.skip-analyze-scene.v1'
const DIRECTOR_SKIP_CHARACTER_ANCHORS_STORAGE_KEY = 'director.skip-character-anchors.v1'
const DIRECTOR_VISION_DETAIL_ANALYZE_SCENE_STORAGE_KEY = 'director.vision-detail.analyze-scene.v1'
const DIRECTOR_VISION_DETAIL_CHARACTER_ANCHORS_STORAGE_KEY = 'director.vision-detail.character-anchors.v1'
const DIRECTOR_VISION_DETAIL_DESIGN_ASSEMBLE_STORAGE_KEY = 'director.vision-detail.design-assemble.v1'
const DIRECTOR_VISION_DETAIL_VERIFY_CONSISTENCY_STORAGE_KEY = 'director.vision-detail.verify-consistency.v1'
const DEFAULT_DIRECTOR_RATIO = '16:9'

function getOrientationByRatio(ratio: string, fallback: LayoutOrientation = 'landscape'): LayoutOrientation {
  const [w, h] = ratio.split(':').map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h)) return fallback
  return w < h ? 'portrait' : 'landscape'
}

function readLayoutOrientation(): LayoutOrientation | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(DIRECTOR_LAYOUT_ORIENTATION_STORAGE_KEY)
    if (raw === 'portrait' || raw === 'landscape') return raw
    return null
  } catch {
    return null
  }
}

function writeLayoutOrientation(value: LayoutOrientation): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(DIRECTOR_LAYOUT_ORIENTATION_STORAGE_KEY, value)
  } catch {
    // Best-effort persistence.
  }
}

function readLayoutOrientationAuto(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return true
    const raw = window.localStorage.getItem(DIRECTOR_LAYOUT_ORIENTATION_AUTO_STORAGE_KEY)
    if (raw === 'false') return false
    if (raw === 'true') return true
    return true
  } catch {
    return true
  }
}

function readSemanticOrientation(): LayoutOrientation | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(DIRECTOR_SEMANTIC_ORIENTATION_STORAGE_KEY)
    if (raw === 'portrait' || raw === 'landscape') return raw
    return null
  } catch {
    return null
  }
}

function writeSemanticOrientation(value: LayoutOrientation): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(DIRECTOR_SEMANTIC_ORIENTATION_STORAGE_KEY, value)
  } catch {
    // Best-effort persistence.
  }
}

function readSemanticOrientationAuto(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return true
    const raw = window.localStorage.getItem(DIRECTOR_SEMANTIC_ORIENTATION_AUTO_STORAGE_KEY)
    if (raw === 'false') return false
    if (raw === 'true') return true
    return true
  } catch {
    return true
  }
}

function writeSemanticOrientationAuto(value: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(DIRECTOR_SEMANTIC_ORIENTATION_AUTO_STORAGE_KEY, String(value))
  } catch {
    // Best-effort persistence.
  }
}

function writeLayoutOrientationAuto(value: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(DIRECTOR_LAYOUT_ORIENTATION_AUTO_STORAGE_KEY, String(value))
  } catch {
    // Best-effort persistence.
  }
}

function readScoreThreshold(): number {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_SCORE_THRESHOLD
    const raw = window.localStorage.getItem(SCORE_THRESHOLD_STORAGE_KEY)
    if (!raw) return DEFAULT_SCORE_THRESHOLD
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return DEFAULT_SCORE_THRESHOLD
    return Math.max(0, Math.min(10, Math.round(parsed)))
  } catch {
    return DEFAULT_SCORE_THRESHOLD
  }
}

function writeScoreThreshold(value: number): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(SCORE_THRESHOLD_STORAGE_KEY, String(value))
  } catch {
    // Best-effort persistence.
  }
}

function readDirectorVisionModel(): string {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return ''
    return window.localStorage.getItem(DIRECTOR_VISION_MODEL_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function writeDirectorVisionModel(value: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    if (!value) {
      window.localStorage.removeItem(DIRECTOR_VISION_MODEL_STORAGE_KEY)
      return
    }
    window.localStorage.setItem(DIRECTOR_VISION_MODEL_STORAGE_KEY, value)
  } catch {
    // Best-effort persistence.
  }
}

function readDirectorRatio(): string {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_DIRECTOR_RATIO
    return window.localStorage.getItem(DIRECTOR_RATIO_STORAGE_KEY) || DEFAULT_DIRECTOR_RATIO
  } catch {
    return DEFAULT_DIRECTOR_RATIO
  }
}

function writeDirectorRatio(value: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(DIRECTOR_RATIO_STORAGE_KEY, value)
  } catch {
    // Best-effort persistence.
  }
}

function normalizeVisionDetail(value: string | null | undefined, fallback: VisionDetail): VisionDetail {
  return value === 'low' || value === 'high' || value === 'auto'
    ? value
    : fallback
}

function readVisionDetail(storageKey: string, fallback: VisionDetail): VisionDetail {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback
    return normalizeVisionDetail(window.localStorage.getItem(storageKey), fallback)
  } catch {
    return fallback
  }
}

function writeVisionDetail(storageKey: string, value: VisionDetail): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(storageKey, value)
  } catch {
    // Best-effort persistence.
  }
}

function readSkipFlag(storageKey: string): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    return window.localStorage.getItem(storageKey) === 'true'
  } catch {
    return false
  }
}

function writeSkipFlag(storageKey: string, value: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(storageKey, String(value))
  } catch {
    // Best-effort persistence.
  }
}

export function detectVisionDetailPreset(config: {
  visionDetailTaskPlanning: VisionDetail
  visionDetailAnalyzeScene: VisionDetail
  visionDetailCharacterAnchors: VisionDetail
  visionDetailDesignAssemble: VisionDetail
  visionDetailVerifyConsistency: VisionDetail
}): VisionDetailPresetState {
  if (
    config.visionDetailTaskPlanning === 'low' &&
    config.visionDetailAnalyzeScene === 'high' &&
    config.visionDetailCharacterAnchors === 'high' &&
    config.visionDetailDesignAssemble === 'low' &&
    config.visionDetailVerifyConsistency === 'low'
  ) {
    return 'speed'
  }
  if (
    config.visionDetailTaskPlanning === 'low' &&
    config.visionDetailAnalyzeScene === 'high' &&
    config.visionDetailCharacterAnchors === 'high' &&
    config.visionDetailDesignAssemble === 'auto' &&
    config.visionDetailVerifyConsistency === 'auto'
  ) {
    return 'balanced'
  }
  if (
    config.visionDetailTaskPlanning === 'high' &&
    config.visionDetailAnalyzeScene === 'high' &&
    config.visionDetailCharacterAnchors === 'high' &&
    config.visionDetailDesignAssemble === 'high' &&
    config.visionDetailVerifyConsistency === 'high'
  ) {
    return 'quality'
  }
  return 'custom'
}

const initialImageState: Pick<ImageSlice, 'referenceImages'> = {
  referenceImages: [],
}

const initialGenerationState: Pick<
  GenerationSlice,
  'isGenerating' | 'generationStatus' | 'isProcessingFiles' | 'generatedResults' | 'lastAnalysisResult' | 'lastCharacterAnchor' | 'lastPipelineState' | 'viewState' | 'currentProgress' | 'passStatuses' | 'passCards' | 'progressPercentage' | 'regenerateCount'
> = {
  isGenerating: false,
  generationStatus: 'idle' as GenerationStatus,
  isProcessingFiles: false,
  generatedResults: [],
  lastAnalysisResult: null,
  lastCharacterAnchor: null,
  lastPipelineState: null,
  viewState: 'idle',
  currentProgress: null,
  passStatuses: [],
  regenerateCount: 2,
  passCards: [],
  progressPercentage: 0,
}

const createInitialConfigState = (): Pick<
  ConfigSlice,
  'currentLayout' | 'currentLayoutOrientation' | 'isLayoutOrientationAuto' | 'currentSemanticOrientation' | 'isSemanticOrientationAuto' | 'currentTemplate' | 'currentMode' | 'currentRatio' | 'currentResolution' | 'sceneDescription' | 'multiSceneText' | 'visionModel' | 'imageModel' | 'imageCount' | 'skipTaskPlanning' | 'skipVerify' | 'skipAnalyzeScene' | 'skipCharacterAnchors' | 'enableCreativePreplanner' | 'scoreThreshold' | 'visionDetailTaskPlanning' | 'visionDetailAnalyzeScene' | 'visionDetailCharacterAnchors' | 'visionDetailDesignAssemble' | 'visionDetailVerifyConsistency'
> => ({
  currentLayout: '6grid',
  currentLayoutOrientation: readLayoutOrientation() || getOrientationByRatio(readDirectorRatio()),
  isLayoutOrientationAuto: readLayoutOrientationAuto(),
  currentSemanticOrientation: readSemanticOrientation() || getOrientationByRatio(readDirectorRatio()),
  isSemanticOrientationAuto: readSemanticOrientationAuto(),
  currentTemplate: 'cinematic',
  currentMode: 'single',
  currentRatio: readDirectorRatio(),
  currentResolution: '2K',
  sceneDescription: '',
  multiSceneText: '',
  visionModel: readDirectorVisionModel(),
  imageModel: '',
  imageCount: 1,
  skipVerify: false,
  skipTaskPlanning: readSkipFlag(DIRECTOR_SKIP_TASK_PLANNING_STORAGE_KEY),
  skipAnalyzeScene: readSkipFlag(DIRECTOR_SKIP_ANALYZE_SCENE_STORAGE_KEY),
  skipCharacterAnchors: readSkipFlag(DIRECTOR_SKIP_CHARACTER_ANCHORS_STORAGE_KEY),
  enableCreativePreplanner: readSkipFlag('director.enable-creative-preplanner.v1'),
  scoreThreshold: readScoreThreshold(),
  visionDetailTaskPlanning: readVisionDetail(DIRECTOR_VISION_DETAIL_TASK_PLANNING_STORAGE_KEY, 'low'),
  visionDetailAnalyzeScene: readVisionDetail(DIRECTOR_VISION_DETAIL_ANALYZE_SCENE_STORAGE_KEY, 'high'),
  visionDetailCharacterAnchors: readVisionDetail(DIRECTOR_VISION_DETAIL_CHARACTER_ANCHORS_STORAGE_KEY, 'high'),
  visionDetailDesignAssemble: readVisionDetail(DIRECTOR_VISION_DETAIL_DESIGN_ASSEMBLE_STORAGE_KEY, 'low'),
  visionDetailVerifyConsistency: readVisionDetail(DIRECTOR_VISION_DETAIL_VERIFY_CONSISTENCY_STORAGE_KEY, 'low'),
})

const initialConfigState = createInitialConfigState()

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
  setIsGenerating: (val) => set({
    isGenerating: val,
    generationStatus: val ? 'running' : 'idle',
  }),
  setGenerationStatus: (status) => set({
    generationStatus: status,
    isGenerating: status === 'running',
  }),
  setIsProcessingFiles: (val) => set({ isProcessingFiles: val }),
  setGeneratedResults: (val) =>
    set((state) => ({
      generatedResults: typeof val === 'function'
        ? (val as (prev: GeneratedResult[]) => GeneratedResult[])(state.generatedResults)
        : val,
    })),
  setLastAnalysisResult: (val) => set({ lastAnalysisResult: val }),
  setLastCharacterAnchor: (val) => set({ lastCharacterAnchor: val }),
  setLastPipelineState: (val) => set({ lastPipelineState: val }),
  setViewState: (val) => set({ viewState: val }),
  setRegenerateCount: (val) => set({ regenerateCount: val }),
  setCurrentProgress: (val) => set({ currentProgress: val }),
  pushProgress: (progress) => set((state) => {
    // UI shows pass 0 (selectSkills) through pass N, so total slots = totalPasses + 1
    const totalPasses = progress.totalPasses || 6
    const slotCount = totalPasses + 1
    const statuses = [...state.passStatuses]
    while (statuses.length < slotCount) statuses.push('pending')
    for (let i = 0; i < progress.pass; i++) {
      if (i < statuses.length && (statuses[i] === 'pending' || statuses[i] === 'running')) {
        statuses[i] = 'completed'
      }
    }
    const idx = progress.pass
    if (idx >= 0 && idx < statuses.length) {
      statuses[idx] = progress.status === 'completed' ? 'completed'
        : progress.status === 'retrying' ? 'retrying'
        : progress.status === 'failed' ? 'failed'
        : 'running'
    }

    const completedCount = statuses.filter(s => s === 'completed').length
    const pct = Math.min(Math.round((completedCount / slotCount) * 100), 100)

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
  setLayoutOrientation: (val) => {
    writeLayoutOrientation(val)
    writeLayoutOrientationAuto(false)
    set({
      currentLayoutOrientation: val,
      isLayoutOrientationAuto: false,
    })
  },
  setLayoutOrientationAuto: (val) => set((state) => {
    const nextOrientation = val
      ? getOrientationByRatio(state.currentRatio, state.currentLayoutOrientation)
      : state.currentLayoutOrientation
    writeLayoutOrientationAuto(val)
    writeLayoutOrientation(nextOrientation)
    return {
      isLayoutOrientationAuto: val,
      currentLayoutOrientation: nextOrientation,
    }
  }),
  setSemanticOrientation: (val) => {
    writeSemanticOrientation(val)
    writeSemanticOrientationAuto(false)
    set({
      currentSemanticOrientation: val,
      isSemanticOrientationAuto: false,
    })
  },
  setSemanticOrientationAuto: (val) => set((state) => {
    const nextOrientation = val
      ? getOrientationByRatio(state.currentRatio, state.currentSemanticOrientation)
      : state.currentSemanticOrientation
    writeSemanticOrientationAuto(val)
    writeSemanticOrientation(nextOrientation)
    return {
      isSemanticOrientationAuto: val,
      currentSemanticOrientation: nextOrientation,
    }
  }),
  setTemplate: (val) => set({ currentTemplate: val }),
  setMode: (val) => set({ currentMode: val }),
  setRatio: (val) => {
    writeDirectorRatio(val)
    set((state) => ({
      currentRatio: val,
      currentLayoutOrientation: (() => {
        const nextOrientation = state.isLayoutOrientationAuto
          ? getOrientationByRatio(val, state.currentLayoutOrientation)
          : state.currentLayoutOrientation
        writeLayoutOrientation(nextOrientation)
        return nextOrientation
      })(),
      currentSemanticOrientation: (() => {
        const nextOrientation = state.isSemanticOrientationAuto
          ? getOrientationByRatio(val, state.currentSemanticOrientation)
          : state.currentSemanticOrientation
        writeSemanticOrientation(nextOrientation)
        return nextOrientation
      })(),
    }))
  },
  setResolution: (val) => set({ currentResolution: val }),
  setSceneDescription: (val) => set({ sceneDescription: val }),
  setMultiSceneText: (val) => set({ multiSceneText: val }),
  setVisionModel: (val) => {
    writeDirectorVisionModel(val)
    set({ visionModel: val })
  },
  setImageModel: (val) => set({ imageModel: val }),
  setImageCount: (val) => set({ imageCount: val }),
  setSkipVerify: (val) => set({ skipVerify: val }),
  setSkipTaskPlanning: (val) => {
    writeSkipFlag(DIRECTOR_SKIP_TASK_PLANNING_STORAGE_KEY, val)
    set({ skipTaskPlanning: val })
  },
  setSkipAnalyzeScene: (val) => {
    writeSkipFlag(DIRECTOR_SKIP_ANALYZE_SCENE_STORAGE_KEY, val)
    set({ skipAnalyzeScene: val })
  },
  setSkipCharacterAnchors: (val) => {
    writeSkipFlag(DIRECTOR_SKIP_CHARACTER_ANCHORS_STORAGE_KEY, val)
    set({ skipCharacterAnchors: val })
  },
  setEnableCreativePreplanner: (val) => {
    writeSkipFlag('director.enable-creative-preplanner.v1', val)
    set({ enableCreativePreplanner: val })
  },
  setScoreThreshold: (val) => {
    const next = Math.max(0, Math.min(10, Math.round(val)))
    writeScoreThreshold(next)
    set({ scoreThreshold: next })
  },
  setVisionDetailTaskPlanning: (val) => {
    writeVisionDetail(DIRECTOR_VISION_DETAIL_TASK_PLANNING_STORAGE_KEY, val)
    set({ visionDetailTaskPlanning: val })
  },
  setVisionDetailAnalyzeScene: (val) => {
    writeVisionDetail(DIRECTOR_VISION_DETAIL_ANALYZE_SCENE_STORAGE_KEY, val)
    set({ visionDetailAnalyzeScene: val })
  },
  setVisionDetailCharacterAnchors: (val) => {
    writeVisionDetail(DIRECTOR_VISION_DETAIL_CHARACTER_ANCHORS_STORAGE_KEY, val)
    set({ visionDetailCharacterAnchors: val })
  },
  setVisionDetailDesignAssemble: (val) => {
    writeVisionDetail(DIRECTOR_VISION_DETAIL_DESIGN_ASSEMBLE_STORAGE_KEY, val)
    set({ visionDetailDesignAssemble: val })
  },
  setVisionDetailVerifyConsistency: (val) => {
    writeVisionDetail(DIRECTOR_VISION_DETAIL_VERIFY_CONSISTENCY_STORAGE_KEY, val)
    set({ visionDetailVerifyConsistency: val })
  },
  applyVisionDetailPreset: (preset) => {
    const next = preset === 'quality'
      ? {
          visionDetailTaskPlanning: 'high' as VisionDetail,
          visionDetailAnalyzeScene: 'high' as VisionDetail,
          visionDetailCharacterAnchors: 'high' as VisionDetail,
          visionDetailDesignAssemble: 'high' as VisionDetail,
          visionDetailVerifyConsistency: 'high' as VisionDetail,
        }
      : preset === 'balanced'
        ? {
            visionDetailTaskPlanning: 'low' as VisionDetail,
            visionDetailAnalyzeScene: 'high' as VisionDetail,
            visionDetailCharacterAnchors: 'high' as VisionDetail,
            visionDetailDesignAssemble: 'auto' as VisionDetail,
            visionDetailVerifyConsistency: 'auto' as VisionDetail,
          }
        : {
            visionDetailTaskPlanning: 'low' as VisionDetail,
            visionDetailAnalyzeScene: 'high' as VisionDetail,
            visionDetailCharacterAnchors: 'high' as VisionDetail,
            visionDetailDesignAssemble: 'low' as VisionDetail,
            visionDetailVerifyConsistency: 'low' as VisionDetail,
          }

    writeVisionDetail(DIRECTOR_VISION_DETAIL_TASK_PLANNING_STORAGE_KEY, next.visionDetailTaskPlanning)
    writeVisionDetail(DIRECTOR_VISION_DETAIL_ANALYZE_SCENE_STORAGE_KEY, next.visionDetailAnalyzeScene)
    writeVisionDetail(DIRECTOR_VISION_DETAIL_CHARACTER_ANCHORS_STORAGE_KEY, next.visionDetailCharacterAnchors)
    writeVisionDetail(DIRECTOR_VISION_DETAIL_DESIGN_ASSEMBLE_STORAGE_KEY, next.visionDetailDesignAssemble)
    writeVisionDetail(DIRECTOR_VISION_DETAIL_VERIFY_CONSISTENCY_STORAGE_KEY, next.visionDetailVerifyConsistency)
    set(next)
  },
})

const createResetSlice: StateCreator<DirectorStore, [], [], ResetSlice> = (set) => ({
  reset: () =>
    set({
      ...initialImageState,
      ...initialGenerationState,
      ...createInitialConfigState(),
    }),
})

// --- Store ---

export const useDirectorStore = create<DirectorStore>()((...a) => ({
  ...createImageSlice(...a),
  ...createGenerationSlice(...a),
  ...createConfigSlice(...a),
  ...createResetSlice(...a),
}))
