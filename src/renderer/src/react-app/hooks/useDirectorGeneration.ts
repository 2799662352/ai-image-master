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

const STYLE_TEMPLATES: Record<string, { prefix: string; suffix: string }> = {
  anime: { prefix: 'anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, ', suffix: ', masterpiece, best quality, absurdres, very aesthetic, full color, anime cel shading, TV anime coloring' },
  manga: { prefix: 'manga panel, comic storyboard, sequential art, black and white manga, screentone, ', suffix: ', masterpiece, best quality, manga style, high contrast, dynamic lines, speech bubbles layout' },
  movie: { prefix: 'cinematic storyboard, film still, movie scene, cinematography, ', suffix: ', masterpiece, best quality, cinematic lighting, depth of field, widescreen, film grain, color grading' },
  webtoon: { prefix: 'webtoon style, korean manhwa, full color comic, vertical scroll format, ', suffix: ', masterpiece, best quality, soft shading, clean lineart, vibrant colors, romantic atmosphere' },
  comic: { prefix: 'american comic style, superhero comic, comic book panel, bold lineart, ', suffix: ', masterpiece, best quality, dynamic pose, strong contrast, halftone dots, action scene' },
  illustration: { prefix: 'illustration, detailed artwork, artistic composition, ', suffix: ', masterpiece, best quality, highly detailed, beautiful lighting, artistic, professional illustration' },
  cinematic: { prefix: 'Cinematic Contact Sheet, award-winning trailer storyboard, precise grid layout with equal panels. Symmetrical grid, hard borders, clean white dividing lines. ', suffix: ', photorealistic, sequence photography, 8K resolution, natural depth of field, deeper DoF in wides shallower in close-ups with natural bokeh' },
  theatrical: { prefix: '((劇場版クオリティのスクリーンショット:1.5)), ((TVアニメの没入感:1.4)), ', suffix: ', 高品質, 8k, masterpiece, best quality, absurdres, cinematic lighting, highly detailed, depth of field, anime screencap' },
}

function getStyleInstructions(templateKey: string | null): string {
  if (!templateKey) return ''
  const t = STYLE_TEMPLATES[templateKey]
  if (!t) return ''
  return `${t.prefix}[SUBJECT]${t.suffix}`
}

export function useDirectorGeneration() {
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const isGenerating = useDirectorStore((s) => s.isGenerating)
  const visionModel = useDirectorStore((s) => s.visionModel)
  const sceneDescription = useDirectorStore((s) => s.sceneDescription)
  const currentLayout = useDirectorStore((s) => s.currentLayout)
  const currentTemplate = useDirectorStore((s) => s.currentTemplate)
  const currentMode = useDirectorStore((s) => s.currentMode)
  const currentRatio = useDirectorStore((s) => s.currentRatio)
  const currentResolution = useDirectorStore((s) => s.currentResolution)
  const imageCount = useDirectorStore((s) => s.imageCount)
  const multiSceneText = useDirectorStore((s) => s.multiSceneText)

  const canGenerate = referenceImages.length > 0 && !isGenerating

  const getLayoutConfig = useCallback((layout?: string): LayoutConfig => {
    return LAYOUT_MAP[layout ?? currentLayout] ?? DEFAULT_LAYOUT
  }, [currentLayout])

  const executeSingle = useCallback(
    async (
      pipeline: any,
      scene: string,
      resolvedStyle: string,
      layoutConfig: LayoutConfig,
      onProgress?: (progress: PipelineProgress) => void,
    ) => {
      return pipeline.execute(
        {
          inputImages: referenceImages.map((img) => ({
            data: img.data,
            mimeType: img.mimeType,
          })),
          sceneDescription: scene,
          layout: layoutConfig,
          template: currentTemplate ?? '',
          styleInstructions: resolvedStyle,
          ratio: currentRatio,
          resolution: currentResolution,
          currentImageCount: imageCount,
        },
        onProgress,
      )
    },
    [referenceImages, currentTemplate, currentRatio, currentResolution, imageCount],
  )

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
        const resolvedStyle = styleInstructions || getStyleInstructions(currentTemplate)

        if (currentMode === 'multi' && multiSceneText.trim()) {
          const scenes = multiSceneText
            .split(/\n\s*\n/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)

          const allResults: Array<{ url: string; prompt: string; timestamp: number }> = []

          for (let i = 0; i < scenes.length; i++) {
            const result = await executeSingle(
              pipeline, scenes[i], resolvedStyle, layoutConfig, onProgress,
            )
            if (result.images) {
              allResults.push(
                ...result.images.map((img: any) => ({
                  url: img.url,
                  prompt: img.prompt,
                  timestamp: Date.now(),
                }))
              )
            }
            store.setGeneratedResults([...allResults])
          }

          if (allResults.length > 0) {
            const lastResult = await executeSingle(
              pipeline, scenes[scenes.length - 1], resolvedStyle, layoutConfig,
            ).catch(() => null)
            if (lastResult?.scene) store.setLastAnalysisResult(JSON.stringify(lastResult.scene))
            if (lastResult?.characters) store.setLastCharacterAnchor(JSON.stringify(lastResult.characters))
          }
        } else {
          const result = await executeSingle(
            pipeline, sceneDescription, resolvedStyle, layoutConfig, onProgress,
          )

          store.setGeneratedResults(
            result.images.map((img: any) => ({
              url: img.url,
              prompt: img.prompt,
              timestamp: Date.now(),
            }))
          )

          if (result.scene) store.setLastAnalysisResult(JSON.stringify(result.scene))
          if (result.characters) store.setLastCharacterAnchor(JSON.stringify(result.characters))

          return result
        }
      } finally {
        useDirectorStore.getState().setIsGenerating(false)
      }
    },
    [
      visionModel,
      referenceImages,
      sceneDescription,
      currentMode,
      multiSceneText,
      currentLayout,
      currentTemplate,
      currentRatio,
      currentResolution,
      imageCount,
      getLayoutConfig,
      executeSingle,
    ]
  )

  return { canGenerate, isGenerating, startGeneration, getLayoutConfig }
}
