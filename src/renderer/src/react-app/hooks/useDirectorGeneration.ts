import { useCallback } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'
import type { PipelineProgress } from '@/services/pipeline/types'

interface LayoutConfig {
  rows: number
  cols: number
  panelCount: number
}

const LAYOUT_MAP: Record<string, LayoutConfig> = {
  '6grid': { rows: 2, cols: 3, panelCount: 6 },
  '4grid': { rows: 2, cols: 2, panelCount: 4 },
  '2closeup': { rows: 1, cols: 2, panelCount: 2 },
  '9grid': { rows: 3, cols: 3, panelCount: 9 },
}

const DEFAULT_LAYOUT: LayoutConfig = LAYOUT_MAP['6grid']

export function useDirectorGeneration() {
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const isGenerating = useDirectorStore((s) => s.isGenerating)
  const visionModel = useDirectorStore((s) => s.visionModel)
  const sceneDescription = useDirectorStore((s) => s.sceneDescription)
  const currentLayout = useDirectorStore((s) => s.currentLayout)
  const currentTemplate = useDirectorStore((s) => s.currentTemplate)
  const currentRatio = useDirectorStore((s) => s.currentRatio)
  const currentResolution = useDirectorStore((s) => s.currentResolution)

  const canGenerate = referenceImages.length > 0 && !isGenerating

  const getLayoutConfig = useCallback((layout?: string): LayoutConfig => {
    return LAYOUT_MAP[layout ?? currentLayout] ?? DEFAULT_LAYOUT
  }, [currentLayout])

  const startGeneration = useCallback(
    async (
      onProgress?: (progress: PipelineProgress) => void,
      styleInstructions?: string
    ) => {
      const store = useDirectorStore.getState()
      store.setIsGenerating(true)

      try {
        const { getDirectorPipelineService } = await import(
          '@/services/ServiceBridge'
        )
        const pipeline = await getDirectorPipelineService(visionModel)
        if (!pipeline) {
          throw new Error('Failed to initialize pipeline service')
        }

        const layoutConfig = getLayoutConfig(currentLayout)

        const result = await pipeline.execute(
          {
            inputImages: referenceImages.map((img) => ({
              data: img.data,
              mimeType: img.mimeType,
            })),
            sceneDescription,
            layout: layoutConfig,
            template: currentTemplate ?? '',
            styleInstructions: styleInstructions ?? '',
            ratio: currentRatio,
            resolution: currentResolution,
          },
          onProgress
        )

        store.setGeneratedResults(
          result.images.map((img) => ({
            url: img.url,
            prompt: img.prompt,
            timestamp: Date.now(),
          }))
        )

        if (result.scene) {
          store.setLastAnalysisResult(JSON.stringify(result.scene))
        }
        if (result.characters) {
          store.setLastCharacterAnchor(JSON.stringify(result.characters))
        }

        return result
      } finally {
        useDirectorStore.getState().setIsGenerating(false)
      }
    },
    [
      visionModel,
      referenceImages,
      sceneDescription,
      currentLayout,
      currentTemplate,
      currentRatio,
      currentResolution,
      getLayoutConfig,
    ]
  )

  return { canGenerate, isGenerating, startGeneration, getLayoutConfig }
}
