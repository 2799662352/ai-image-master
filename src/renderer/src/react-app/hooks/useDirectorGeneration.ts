import { useCallback, useRef } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'
import type { LayoutOrientation } from '../stores/useDirectorStore'
import { useShallow } from 'zustand/react/shallow'
import { getStyleInstructions } from '../constants/templates'
import type { PipelineProgress } from '@/services/pipeline/types'

async function saveToHistory(
  images: Array<{ url: string; prompt: string }>,
  fallbackPrompt: string,
  ratio: string,
): Promise<void> {
  if (images.length === 0) return
  try {
    const historyService = (window as any).historyDataServiceTS
    if (!historyService?.addToHistory) return
    const urls = images.map((img) => img.url)
    const prompt = images[0]?.prompt || fallbackPrompt || '导演模式生成'
    await historyService.addToHistory('generate-with-reference', prompt, urls, ratio)
  } catch (e) {
    console.warn('[Director] 历史记录保存失败:', e)
  }
}

interface LayoutConfig {
  rows: number
  cols: number
  panelCount: number
}

const LANDSCAPE_LAYOUT_MAP: Record<string, LayoutConfig> = {
  '6grid': { rows: 2, cols: 3, panelCount: 6 },
  '4grid': { rows: 2, cols: 2, panelCount: 4 },
  '2closeup': { rows: 1, cols: 2, panelCount: 2 },
  '9grid': { rows: 3, cols: 3, panelCount: 9 },
  '16grid': { rows: 4, cols: 4, panelCount: 16 },
  '25grid': { rows: 5, cols: 5, panelCount: 25 },
}

const PORTRAIT_LAYOUT_MAP: Record<string, LayoutConfig> = {
  '6grid': { rows: 3, cols: 2, panelCount: 6 },
  '4grid': { rows: 2, cols: 2, panelCount: 4 },
  '2closeup': { rows: 2, cols: 1, panelCount: 2 },
  '9grid': { rows: 3, cols: 3, panelCount: 9 },
  '16grid': { rows: 4, cols: 4, panelCount: 16 },
  '25grid': { rows: 5, cols: 5, panelCount: 25 },
}

function getLayoutMapByOrientation(orientation: LayoutOrientation): Record<string, LayoutConfig> {
  return orientation === 'portrait' ? PORTRAIT_LAYOUT_MAP : LANDSCAPE_LAYOUT_MAP
}

const DEFAULT_LAYOUT: LayoutConfig = LANDSCAPE_LAYOUT_MAP['6grid']

export function useDirectorGeneration() {
  const abortControllerRef = useRef<AbortController | null>(null)
  const pipelineRef = useRef<any>(null)

  const {
    referenceImages,
    isGenerating,
    generationStatus,
    visionModel,
    imageModel,
    sceneDescription,
    currentLayout,
    currentTemplate,
    currentMode,
    currentRatio,
    currentLayoutOrientation,
    currentSemanticOrientation,
    currentResolution,
    imageCount,
    multiSceneText,
    skipVerify,
    skipAnalyzeScene,
    skipCharacterAnchors,
    scoreThreshold,
    visionDetailAnalyzeScene,
    visionDetailCharacterAnchors,
    visionDetailDesignAssemble,
    visionDetailVerifyConsistency,
  } = useDirectorStore(useShallow((s) => ({
    referenceImages: s.referenceImages,
    isGenerating: s.isGenerating,
    generationStatus: s.generationStatus,
    visionModel: s.visionModel,
    imageModel: s.imageModel,
    sceneDescription: s.sceneDescription,
    currentLayout: s.currentLayout,
    currentTemplate: s.currentTemplate,
    currentMode: s.currentMode,
    currentRatio: s.currentRatio,
    currentLayoutOrientation: s.currentLayoutOrientation,
    currentSemanticOrientation: s.currentSemanticOrientation,
    currentResolution: s.currentResolution,
    imageCount: s.imageCount,
    multiSceneText: s.multiSceneText,
    skipVerify: s.skipVerify,
    skipAnalyzeScene: s.skipAnalyzeScene,
    skipCharacterAnchors: s.skipCharacterAnchors,
    scoreThreshold: s.scoreThreshold,
    visionDetailAnalyzeScene: s.visionDetailAnalyzeScene,
    visionDetailCharacterAnchors: s.visionDetailCharacterAnchors,
    visionDetailDesignAssemble: s.visionDetailDesignAssemble,
    visionDetailVerifyConsistency: s.visionDetailVerifyConsistency,
  })))

  const canGenerate = referenceImages.length > 0 && !isGenerating

  const resolveVisionModel = useCallback((): string => {
    const model = (visionModel || '').trim()
    if (!model) {
      throw new Error('未检测到视觉模型，请先在导演模式中选择“视觉模型(分析)”')
    }
    return model
  }, [visionModel])

  const resolveImageModel = useCallback((): string => {
    const globalModel =
      localStorage.getItem('current_model') ||
      (window as any).modelSelectorManagerTS?.getCurrentModelKey?.() ||
      ''
    return globalModel || imageModel
  }, [imageModel])

  const getLayoutConfig = useCallback((layout?: string): LayoutConfig => {
    const map = getLayoutMapByOrientation(currentLayoutOrientation)
    return map[layout ?? currentLayout] ?? map['6grid'] ?? DEFAULT_LAYOUT
  }, [currentLayout, currentLayoutOrientation])

  const executeSingle = useCallback(
    async (
      pipeline: any,
      scene: string,
      resolvedStyle: string,
      layoutConfig: LayoutConfig,
      drawingModel: string,
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
          semanticOrientation: currentSemanticOrientation,
          imageModel: drawingModel,
          ratio: currentRatio,
          resolution: currentResolution,
          currentImageCount: imageCount,
          skipVerify,
          skipAnalyzeScene,
          skipCharacterAnchors,
          scoreThreshold,
          visionDetailAnalyzeScene,
          visionDetailCharacterAnchors,
          visionDetailDesignAssemble,
          visionDetailVerifyConsistency,
        },
        onProgress,
      )
    },
    [
      referenceImages,
      currentTemplate,
      currentSemanticOrientation,
      currentRatio,
      currentResolution,
      imageCount,
      skipVerify,
      skipAnalyzeScene,
      skipCharacterAnchors,
      scoreThreshold,
      visionDetailAnalyzeScene,
      visionDetailCharacterAnchors,
      visionDetailDesignAssemble,
      visionDetailVerifyConsistency,
    ],
  )

  const startGeneration = useCallback(
    async (
      onProgress?: (progress: PipelineProgress) => void,
      styleInstructions?: string
    ) => {
      const store = useDirectorStore.getState()
      store.setGenerationStatus('running')

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      try {
        const analysisModel = resolveVisionModel()
        const drawingModel = resolveImageModel()
        if (!drawingModel) {
          throw new Error('未检测到绘图模型，请先在顶部模型选择器中选择生图模型')
        }
        if (analysisModel === drawingModel) {
          throw new Error('视觉模型与绘图模型不能混用，请分别设置“视觉模型(分析)”与顶部“绘图模型(出图)”')
        }
        store.setImageModel(drawingModel)

        const { getDirectorPipelineService } = await import(
          '@/services/ServiceBridge'
        )
        const pipeline = await getDirectorPipelineService(analysisModel)
        if (!pipeline) {
          throw new Error('Failed to initialize pipeline service')
        }
        pipelineRef.current = pipeline

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
              pipeline, scenes[i], resolvedStyle, layoutConfig, drawingModel, onProgress,
            )
            if (result.images?.length) {
              const mapped = result.images.map((img: any) => ({
                url: img.url,
                prompt: img.prompt,
                timestamp: Date.now(),
              }))
              allResults.push(...mapped)
              store.setGeneratedResults([...allResults])
              // 历史记录保存不应阻塞主流程收尾；后台异步即可
              void saveToHistory(mapped, scenes[i], currentRatio)
            }
            if (result.scene) store.setLastAnalysisResult(JSON.stringify(result.scene))
            if (result.characters) store.setLastCharacterAnchor(JSON.stringify(result.characters))
          }
        } else {
          const result = await executeSingle(
            pipeline, sceneDescription, resolvedStyle, layoutConfig, drawingModel, onProgress,
          )
          const mappedImages = (result.images ?? []).map((img: any) => ({
            url: img.url,
            prompt: img.prompt,
            timestamp: Date.now(),
          }))
          store.setGeneratedResults((prev) => {
            const prevSuccessCount = prev.filter((img) => Boolean(img.url)).length
            const mappedSuccessCount = mappedImages.filter((img) => Boolean(img.url)).length
            // 流式阶段可能已拿到更多成功图片，避免在收尾时被较少结果覆盖
            if (prevSuccessCount > mappedSuccessCount) {
              return prev
            }
            return mappedImages
          })

          if (result.scene) store.setLastAnalysisResult(JSON.stringify(result.scene))
          if (result.characters) store.setLastCharacterAnchor(JSON.stringify(result.characters))

          const normalizedPanels = Array.isArray((result as any)?.panels)
            ? (result as any).panels
            : Array.isArray((result as any)?.panels?.panels)
              ? (result as any).panels.panels
              : null

          store.setLastPipelineState({
            inputImages: referenceImages.map((img) => ({ data: img.data, mimeType: img.mimeType })),
            sceneDescription,
            layout: layoutConfig,
            template: currentTemplate ?? '',
            styleInstructions: resolvedStyle,
            semanticOrientation: currentSemanticOrientation,
            imageModel: drawingModel,
            ratio: currentRatio,
            resolution: currentResolution,
            skipVerify,
            skipAnalyzeScene,
            skipCharacterAnchors,
            scoreThreshold,
            visionDetailAnalyzeScene,
            visionDetailCharacterAnchors,
            visionDetailDesignAssemble,
            visionDetailVerifyConsistency,
            scene: result.scene,
            characters: result.characters,
            panels: normalizedPanels,
            prompts: result.prompts,
            report: result.report,
          })

          void saveToHistory(mappedImages, sceneDescription, currentRatio)

          return result
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          console.log('[Director] 生成已取消')
          return
        }
        throw err
      } finally {
        const s = useDirectorStore.getState()
        if (s.generationStatus === 'running') {
          s.setGenerationStatus('idle')
        }
      }
    },
    [
      visionModel,
      imageModel,
      referenceImages,
      sceneDescription,
      currentMode,
      multiSceneText,
      currentLayout,
      currentTemplate,
      currentRatio,
      currentLayoutOrientation,
      currentSemanticOrientation,
      currentResolution,
      imageCount,
      skipVerify,
      skipAnalyzeScene,
      skipCharacterAnchors,
      scoreThreshold,
      visionDetailAnalyzeScene,
      visionDetailCharacterAnchors,
      visionDetailDesignAssemble,
      visionDetailVerifyConsistency,
      getLayoutConfig,
      executeSingle,
      resolveVisionModel,
      resolveImageModel,
    ]
  )

  const cancelGeneration = useCallback(() => {
    abortControllerRef.current?.abort()
    pipelineRef.current?.clearPauseRequest?.()
    useDirectorStore.getState().setGenerationStatus('idle')
  }, [])

  const pauseGeneration = useCallback(() => {
    pipelineRef.current?.requestPause?.()
  }, [])

  const resumeGeneration = useCallback(
    async (onProgress?: (progress: PipelineProgress) => void) => {
      const pipeline = pipelineRef.current
      if (!pipeline?.resume) {
        console.warn('[Director] 无法恢复: pipeline 未初始化')
        return
      }

      const store = useDirectorStore.getState()
      store.setGenerationStatus('running')

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      try {
        const result = await pipeline.resume(onProgress, { signal: abortController.signal })

        if ((result as any).__paused) {
          store.setGenerationStatus('paused')
          return result
        }

        const mappedImages = (result.images ?? []).map((img: any) => ({
          url: img.url,
          prompt: img.prompt,
          timestamp: Date.now(),
        }))
        store.setGeneratedResults(mappedImages)

        if (result.scene) store.setLastAnalysisResult(JSON.stringify(result.scene))
        if (result.characters) store.setLastCharacterAnchor(JSON.stringify(result.characters))

        return result
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          console.log('[Director] 恢复已取消')
          return
        }
        throw err
      } finally {
        const s = useDirectorStore.getState()
        if (s.generationStatus === 'running') {
          s.setGenerationStatus('idle')
        }
      }
    },
    [],
  )

  const regenerateImages = useCallback(
    async (
      count: number,
      onProgress?: (progress: PipelineProgress) => void,
    ) => {
      const store = useDirectorStore.getState()
      const prevState = store.lastPipelineState
      if (!prevState) {
        throw new Error('没有可复用的分镜数据，请先完整生成一次')
      }

      store.setIsGenerating(true)
      try {
        const analysisModel = resolveVisionModel()
        const drawingModel = resolveImageModel()
        if (!drawingModel) {
          throw new Error('未检测到绘图模型，请先在顶部模型选择器中选择生图模型')
        }
        if (analysisModel === drawingModel) {
          throw new Error('视觉模型与绘图模型不能混用，请分别设置“视觉模型(分析)”与顶部“绘图模型(出图)”')
        }
        store.setImageModel(drawingModel)

        const { getDirectorPipelineService } = await import(
          '@/services/ServiceBridge'
        )
        const pipeline = await getDirectorPipelineService(analysisModel)
        if (!pipeline) {
          throw new Error('Failed to initialize pipeline service')
        }

        const result = await pipeline.regenerateImages(
          { ...prevState, imageModel: drawingModel },
          count,
          onProgress,
          { signal: abortControllerRef.current?.signal },
        )

        const mappedImages = (result.images ?? []).map((img: any) => ({
          url: img.url,
          prompt: img.prompt,
          timestamp: Date.now(),
        }))

        store.setGeneratedResults((prev) => [...prev, ...mappedImages])

        void saveToHistory(mappedImages, String((prevState as any).sceneDescription || ''), currentRatio)

        return result
      } finally {
        useDirectorStore.getState().setIsGenerating(false)
      }
    },
    [currentRatio, resolveVisionModel, resolveImageModel],
  )

  const canRegenerate = useDirectorStore((s) => s.lastPipelineState !== null) && !isGenerating

  return {
    canGenerate,
    canRegenerate,
    isGenerating,
    generationStatus,
    startGeneration,
    regenerateImages,
    cancelGeneration,
    pauseGeneration,
    resumeGeneration,
    getLayoutConfig,
  }
}
