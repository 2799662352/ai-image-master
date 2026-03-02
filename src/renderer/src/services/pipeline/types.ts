import type { SceneAnalysis, CharacterAnchors, DesignAndAssemble, VerifyReport } from './schemas/director-schemas'

export interface PassCardData {
  pass: number
  passName: string
  label: string
  summary: string
  raw: unknown
  elapsed: number
}

export interface PipelineProgress {
  pass: number
  totalPasses: number
  label: string
  status: 'running' | 'completed' | 'retrying' | 'failed'
  data?: unknown
  elapsed?: number
  passData?: PassCardData
}

export interface PipelineConfig {
  model: string
  apiKey: string
  baseURL: string
  maxRetries?: number
  scoreThreshold?: number
}

export interface PipelineSkill {
  id: string
  rules: string | ((context: Record<string, unknown>) => string)
  appliesTo: string[]
  priority: number
  condition?: (context: Record<string, unknown>) => boolean
}

export interface DirectorInput {
  images: Array<{ data: string; mimeType: string }>
  sceneDescription: string
  layout: { rows: number; cols: number; panelCount: number }
  template: string
  styleInstructions: string
  ratio: string
  resolution: string
}

export interface DirectorResult {
  scene: SceneAnalysis | null
  characters: CharacterAnchors | null
  panels: DesignAndAssemble | null
  prompts: AssembledPrompt[]
  report: VerifyReport | null
  images: GeneratedImage[]
}

export interface AssembledPrompt {
  id: number
  prompt: string
  negativePrompt: string
}

export interface GeneratedImage {
  id: number
  url: string
  prompt: string
}
