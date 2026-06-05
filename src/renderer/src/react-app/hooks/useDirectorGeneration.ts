import { useCallback, useRef } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'
import type {
  DirectorReferenceImage,
  GenerationMode,
  LayoutOrientation,
  LayoutType,
  VisionDetail,
} from '../stores/useDirectorStore'
import { useShallow } from 'zustand/react/shallow'
import { getStyleInstructions } from '../constants/templates'
import type { PipelineProgress } from '@/services/pipeline/types'
import { uploadImageUrlToCos } from '../../utils/cosImageUpload'

async function saveToHistory(
  images: Array<{ url: string; prompt: string }>,
  fallbackPrompt: string,
  ratio: string,
): Promise<void> {
  if (images.length === 0) return
  try {
    const historyService = (window as any).historyDataServiceTS
    if (!historyService?.addToHistory) return
    const prompt = images[0]?.prompt || fallbackPrompt || '导演模式生成'

    // Persist permanent COS URLs, not the model's expiring direct links.
    // Director mode previously stored raw model URLs, so its history images
    // vanished once the model URL TTL lapsed — the same class of bug fixed
    // for generate mode. Upload each image to COS first (self-throttled,
    // max 4 concurrent); fall back to the model URL only if the upload
    // fails so we never drop a result outright.
    const urls = await Promise.all(
      images.map(async (img) => {
        try {
          const r = await uploadImageUrlToCos(img.url, {
            metadata: { source: 'director', prompt: img.prompt },
          })
          return r.ok ? r.url : img.url
        } catch {
          return img.url
        }
      }),
    )

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

// Frozen snapshot of all inputs a single generation run needs. Captured at
// enqueue-time so subsequent UI edits (scene text, ref images, layout…)
// don't bleed into in-flight or queued jobs.
interface JobSnapshot {
  referenceImages: DirectorReferenceImage[]
  sceneDescription: string
  multiSceneText: string
  currentMode: GenerationMode
  currentLayout: LayoutType
  currentLayoutOrientation: LayoutOrientation
  currentTemplate: string | null
  currentRatio: string
  currentResolution: string
  currentSemanticOrientation: LayoutOrientation
  imageCount: number
  skipVerify: boolean
  skipTaskPlanning: boolean
  skipAnalyzeScene: boolean
  skipCharacterAnchors: boolean
  skipStyleAnchor: boolean
  enableCreativePreplanner: boolean
  scoreThreshold: number
  maxRetries: number
  visionDetailTaskPlanning: VisionDetail
  visionDetailAnalyzeScene: VisionDetail
  visionDetailCharacterAnchors: VisionDetail
  visionDetailExtractStyleAnchor: VisionDetail
  visionDetailDesignAssemble: VisionDetail
  visionDetailVerifyConsistency: VisionDetail
  visionModel: string
  imageModel: string
}

interface QueuedJob {
  id: number
  styleInstructions?: string
  onProgress?: (progress: PipelineProgress) => void
  snapshot: JobSnapshot
}

function snapshotFromStore(): JobSnapshot {
  const s = useDirectorStore.getState()
  return {
    // Shallow copy: image array becomes immutable for the job's lifetime
    // even if the user removes/replaces refs in the UI before it runs.
    referenceImages: s.referenceImages.slice(),
    sceneDescription: s.sceneDescription,
    multiSceneText: s.multiSceneText,
    currentMode: s.currentMode,
    currentLayout: s.currentLayout,
    currentLayoutOrientation: s.currentLayoutOrientation,
    currentTemplate: s.currentTemplate,
    currentRatio: s.currentRatio,
    currentResolution: s.currentResolution,
    currentSemanticOrientation: s.currentSemanticOrientation,
    imageCount: s.imageCount,
    skipVerify: s.skipVerify,
    skipTaskPlanning: s.skipTaskPlanning,
    skipAnalyzeScene: s.skipAnalyzeScene,
    skipCharacterAnchors: s.skipCharacterAnchors,
    skipStyleAnchor: s.skipStyleAnchor,
    enableCreativePreplanner: s.enableCreativePreplanner,
    scoreThreshold: s.scoreThreshold,
    maxRetries: s.maxRetries,
    visionDetailTaskPlanning: s.visionDetailTaskPlanning,
    visionDetailAnalyzeScene: s.visionDetailAnalyzeScene,
    visionDetailCharacterAnchors: s.visionDetailCharacterAnchors,
    visionDetailExtractStyleAnchor: s.visionDetailExtractStyleAnchor,
    visionDetailDesignAssemble: s.visionDetailDesignAssemble,
    visionDetailVerifyConsistency: s.visionDetailVerifyConsistency,
    visionModel: s.visionModel,
    imageModel: s.imageModel,
  }
}

function getLayoutConfigFor(snapshot: JobSnapshot, layout?: string): LayoutConfig {
  const map = getLayoutMapByOrientation(snapshot.currentLayoutOrientation)
  return map[layout ?? snapshot.currentLayout] ?? map['6grid'] ?? DEFAULT_LAYOUT
}

function resolveVisionModel(snapshot: JobSnapshot): string {
  const model = (snapshot.visionModel || '').trim()
  if (!model) {
    throw new Error('未检测到视觉模型，请先在导演模式中选择"视觉模型(分析)"')
  }
  return model
}

function resolveImageModel(snapshot: JobSnapshot): string {
  const globalModel =
    (typeof window !== 'undefined'
      ? window.localStorage.getItem('current_model') || (window as any).modelSelectorManagerTS?.getCurrentModelKey?.()
      : '') || ''
  return globalModel || snapshot.imageModel
}

export function useDirectorGeneration() {
  // The pipeline + abort controller of the *currently running* job. Single
  // pipeline-at-a-time is a hard requirement (the deep-agent pipeline owns
  // pause/resume internal state that can't be safely multiplexed).
  const abortControllerRef = useRef<AbortController | null>(null)
  const pipelineRef = useRef<any>(null)
  const currentJobIdRef = useRef<number>(0)
  // FIFO queue of jobs waiting to start. Drained by processQueue() one-by-one.
  const queueRef = useRef<QueuedJob[]>([])
  // Single-flight guard: only one processQueue loop runs at a time. Set true
  // for the entire duration of "actively draining the queue", cleared when
  // we stop (queue empty, paused, or cancelled).
  const isProcessingRef = useRef<boolean>(false)
  const jobIdCounterRef = useRef<number>(0)

  const { referenceImages, isGenerating, generationStatus, pendingCount } = useDirectorStore(
    useShallow((s) => ({
      referenceImages: s.referenceImages,
      isGenerating: s.isGenerating,
      generationStatus: s.generationStatus,
      pendingCount: s.pendingCount,
    })),
  )

  // canGenerate stays true even while busy — main button enqueues into the
  // live queue instead of being disabled. Only "no ref images" disables it.
  const canGenerate = referenceImages.length > 0

  const executeSingle = useCallback(
    async (
      pipeline: any,
      snapshot: JobSnapshot,
      scene: string,
      resolvedStyle: string,
      layoutConfig: LayoutConfig,
      drawingModel: string,
      onProgress: ((progress: PipelineProgress) => void) | undefined,
      signal: AbortSignal,
    ) => {
      return pipeline.execute(
        {
          inputImages: snapshot.referenceImages.map((img) => ({
            data: img.data,
            mimeType: img.mimeType,
          })),
          sceneDescription: scene,
          layout: layoutConfig,
          template: snapshot.currentTemplate ?? '',
          styleInstructions: resolvedStyle,
          semanticOrientation: snapshot.currentSemanticOrientation,
          imageModel: drawingModel,
          ratio: snapshot.currentRatio,
          resolution: snapshot.currentResolution,
          currentImageCount: snapshot.imageCount,
          skipVerify: snapshot.skipVerify,
          skipTaskPlanning: snapshot.skipTaskPlanning,
          skipAnalyzeScene: snapshot.skipAnalyzeScene,
          skipCharacterAnchors: snapshot.skipCharacterAnchors,
          skipStyleAnchor: snapshot.skipStyleAnchor,
          enableCreativePreplanner: snapshot.enableCreativePreplanner,
          scoreThreshold: snapshot.scoreThreshold,
          maxRetries: snapshot.maxRetries,
          visionDetailTaskPlanning: snapshot.visionDetailTaskPlanning,
          visionDetailAnalyzeScene: snapshot.visionDetailAnalyzeScene,
          visionDetailCharacterAnchors: snapshot.visionDetailCharacterAnchors,
          visionDetailExtractStyleAnchor: snapshot.visionDetailExtractStyleAnchor,
          visionDetailDesignAssemble: snapshot.visionDetailDesignAssemble,
          visionDetailVerifyConsistency: snapshot.visionDetailVerifyConsistency,
        },
        onProgress,
        { signal },
      )
    },
    [],
  )

  // Runs ONE job against the snapshot. Sets running → resets progress →
  // executes the pipeline (single or multi-scene) → writes results to the
  // store with append semantics → finally sets idle (unless the job paused).
  const runJob = useCallback(
    async (job: QueuedJob): Promise<void> => {
      const { snapshot, onProgress, styleInstructions } = job
      const store = useDirectorStore.getState()

      currentJobIdRef.current = job.id

      // Each job starts a fresh progress timeline (passStatuses, passCards…).
      // Without this, the second job's progress bar would resume from the
      // first job's "completed" state.
      store.resetProgress()
      store.setViewState('generating')
      store.setGenerationStatus('running')

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      try {
        const analysisModel = resolveVisionModel(snapshot)
        const drawingModel = resolveImageModel(snapshot)
        if (!drawingModel) {
          throw new Error('未检测到绘图模型，请先在顶部模型选择器中选择生图模型')
        }
        if (analysisModel === drawingModel) {
          throw new Error('视觉模型与绘图模型不能混用，请分别设置"视觉模型(分析)"与顶部"绘图模型(出图)"')
        }
        store.setImageModel(drawingModel)

        const { getDirectorPipelineService } = await import('@/services/ServiceBridge')
        const pipeline = await getDirectorPipelineService(analysisModel)
        if (!pipeline) {
          throw new Error('导演模式初始化失败: 请确认已在「设置 → Vision API Key」中正确填写 API Key，且当前站点有效')
        }
        pipelineRef.current = pipeline

        const layoutConfig = getLayoutConfigFor(snapshot, snapshot.currentLayout)
        const resolvedStyle = styleInstructions || getStyleInstructions(snapshot.currentTemplate)

        if (snapshot.currentMode === 'multi' && snapshot.multiSceneText.trim()) {
          const scenes = snapshot.multiSceneText
            .split(/\n\s*\n/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)

          for (let i = 0; i < scenes.length; i++) {
            if (abortController.signal.aborted) {
              console.log(`[Director] 多场景模式: 已取消，跳过场景 ${i + 1}/${scenes.length}`)
              break
            }
            const result = await executeSingle(
              pipeline,
              snapshot,
              scenes[i],
              resolvedStyle,
              layoutConfig,
              drawingModel,
              onProgress,
              abortController.signal,
            )

            if (result.__paused) {
              useDirectorStore.getState().setGenerationStatus('paused')
              return
            }

            if (result.images?.length) {
              const mapped = result.images.map((img: any) => ({
                url: img.url,
                prompt: img.prompt,
                timestamp: Date.now(),
              }))
              // Append (not replace) so previous job/scene results stay visible.
              useDirectorStore.getState().setGeneratedResults((prev) => [...prev, ...mapped])
              void saveToHistory(mapped, scenes[i], snapshot.currentRatio)
            }
            if (result.scene) useDirectorStore.getState().setLastAnalysisResult(JSON.stringify(result.scene))
            if (result.characters) useDirectorStore.getState().setLastCharacterAnchor(JSON.stringify(result.characters))
          }
        } else {
          const result = await executeSingle(
            pipeline,
            snapshot,
            snapshot.sceneDescription,
            resolvedStyle,
            layoutConfig,
            drawingModel,
            onProgress,
            abortController.signal,
          )

          if (result.__paused) {
            useDirectorStore.getState().setGenerationStatus('paused')
            return
          }

          const mappedImages = (result.images ?? []).map((img: any) => ({
            url: img.url,
            prompt: img.prompt,
            timestamp: Date.now(),
          }))

          // Stream-then-finalize reconciliation: the progress callback in
          // DirectorApp already appends each image to generatedResults as
          // soon as 'image_generated' fires. By the time runJob's final
          // `result.images` arrives, those images may already be in the
          // store. To avoid duplicating, only append images whose URL isn't
          // already present from this job's streaming pass.
          useDirectorStore.getState().setGeneratedResults((prev) => {
            const seen = new Set(prev.map((img) => img.url).filter(Boolean))
            const fresh = mappedImages.filter((img: { url: string }) => img.url && !seen.has(img.url))
            return fresh.length > 0 ? [...prev, ...fresh] : prev
          })

          if (result.scene) useDirectorStore.getState().setLastAnalysisResult(JSON.stringify(result.scene))
          if (result.characters) useDirectorStore.getState().setLastCharacterAnchor(JSON.stringify(result.characters))

          const normalizedPanels = Array.isArray((result as any)?.panels)
            ? (result as any).panels
            : Array.isArray((result as any)?.panels?.panels)
              ? (result as any).panels.panels
              : null

          useDirectorStore.getState().setLastPipelineState({
            inputImages: snapshot.referenceImages.map((img) => ({ data: img.data, mimeType: img.mimeType })),
            sceneDescription: snapshot.sceneDescription,
            layout: layoutConfig,
            template: snapshot.currentTemplate ?? '',
            styleInstructions: resolvedStyle,
            semanticOrientation: snapshot.currentSemanticOrientation,
            imageModel: drawingModel,
            ratio: snapshot.currentRatio,
            resolution: snapshot.currentResolution,
            skipVerify: snapshot.skipVerify,
            skipTaskPlanning: snapshot.skipTaskPlanning,
            skipAnalyzeScene: snapshot.skipAnalyzeScene,
            skipCharacterAnchors: snapshot.skipCharacterAnchors,
            skipStyleAnchor: snapshot.skipStyleAnchor,
            enableCreativePreplanner: snapshot.enableCreativePreplanner,
            scoreThreshold: snapshot.scoreThreshold,
            maxRetries: snapshot.maxRetries,
            visionDetailTaskPlanning: snapshot.visionDetailTaskPlanning,
            visionDetailAnalyzeScene: snapshot.visionDetailAnalyzeScene,
            visionDetailCharacterAnchors: snapshot.visionDetailCharacterAnchors,
            visionDetailExtractStyleAnchor: snapshot.visionDetailExtractStyleAnchor,
            visionDetailDesignAssemble: snapshot.visionDetailDesignAssemble,
            visionDetailVerifyConsistency: snapshot.visionDetailVerifyConsistency,
            scene: result.scene,
            characters: result.characters,
            panels: normalizedPanels,
            prompts: result.prompts,
            report: result.report,
          })

          void saveToHistory(mappedImages, snapshot.sceneDescription, snapshot.currentRatio)
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          console.log('[Director] 生成已取消')
          return
        }
        // Surface error to UI via toast (mirrors handleGenerate's old behaviour).
        const toast =
          (typeof window !== 'undefined' && ((window as any).toastManagerTS ?? (window as any).toastManager)) || null
        toast?.show?.((err as any)?.message || '生成失败', 'error')
        console.error('[Director] runJob failed:', err)
      } finally {
        const s = useDirectorStore.getState()
        if (s.generationStatus === 'running') {
          s.setGenerationStatus('idle')
          // viewState stays as-is: if we produced results above, the gallery
          // is already mounted; if not, DirectorApp's idle-empty placeholder
          // will reassert next render.
          if (s.generatedResults.length > 0) {
            s.setViewState('results')
          } else {
            s.setViewState('idle')
          }
        }
      }
    },
    [executeSingle],
  )

  // Drains the queue serially. Single-flight via isProcessingRef so multiple
  // enqueue() calls in the same tick still produce one drain loop, not a race.
  const processQueue = useCallback(async (): Promise<void> => {
    if (isProcessingRef.current) return
    if (queueRef.current.length === 0) return
    isProcessingRef.current = true
    try {
      while (queueRef.current.length > 0) {
        // Peek-and-shift only after the run starts: keeps pendingCount in
        // sync with what's "queued behind the running one".
        const job = queueRef.current.shift()!
        useDirectorStore.getState().setPendingCount((n) => n - 1)
        await runJob(job)

        // If the running job paused (pipeline returned __paused), stop draining.
        // The user must explicitly resume or cancel before the next job runs.
        const status = useDirectorStore.getState().generationStatus
        if (status === 'paused') break
      }
    } finally {
      isProcessingRef.current = false
    }
  }, [runJob])

  // Public API: append a snapshot of current store state to the queue and
  // kick the drainer if it's idle. Always synchronous — callers don't need
  // to await. The caller's `onProgress` is captured per-job, so progress
  // callbacks don't bleed across jobs.
  const enqueueGeneration = useCallback(
    (onProgress?: (progress: PipelineProgress) => void, styleInstructions?: string): number => {
      const id = ++jobIdCounterRef.current
      const job: QueuedJob = {
        id,
        styleInstructions,
        onProgress,
        snapshot: snapshotFromStore(),
      }
      queueRef.current.push(job)
      useDirectorStore.getState().setPendingCount((n) => n + 1)
      // Fire-and-forget — processQueue's single-flight guard handles dedupe.
      void processQueue()
      return id
    },
    [processQueue],
  )

  const cancelGeneration = useCallback(() => {
    abortControllerRef.current?.abort()
    pipelineRef.current?.clearPauseRequest?.()
    useDirectorStore.getState().setGenerationStatus('idle')
    // Note: we deliberately do NOT clear queueRef. "Cancel" cancels the
    // currently-running job; pending jobs continue (matches BatchPage UX).
    // The drain loop naturally picks up the next queued job after this
    // job's finally block resolves.
  }, [])

  const pauseGeneration = useCallback(() => {
    pipelineRef.current?.requestPause?.()
  }, [])

  // Resume the *currently paused* job's pipeline, then re-trigger the
  // drain loop so any queued jobs that piled up during the pause also run.
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

        if (result.__paused) {
          useDirectorStore.getState().setGenerationStatus('paused')
          return result
        }

        const mappedImages = (result.images ?? []).map((img: any) => ({
          url: img.url,
          prompt: img.prompt,
          timestamp: Date.now(),
        }))
        useDirectorStore.getState().setGeneratedResults((prev) => {
          const seen = new Set(prev.map((img) => img.url).filter(Boolean))
          const fresh = mappedImages.filter((img: { url: string }) => img.url && !seen.has(img.url))
          return fresh.length > 0 ? [...prev, ...fresh] : prev
        })

        if (result.scene) useDirectorStore.getState().setLastAnalysisResult(JSON.stringify(result.scene))
        if (result.characters) useDirectorStore.getState().setLastCharacterAnchor(JSON.stringify(result.characters))

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
        // After resume completes (or aborts), if more jobs piled up while we
        // were paused, drain them now. processQueue is no-op if already running.
        if (queueRef.current.length > 0) {
          void processQueue()
        }
      }
    },
    [processQueue],
  )

  const regenerateImages = useCallback(
    async (count: number, onProgress?: (progress: PipelineProgress) => void) => {
      const store = useDirectorStore.getState()
      const prevState = store.lastPipelineState
      if (!prevState) {
        throw new Error('没有可复用的分镜数据，请先完整生成一次')
      }

      store.setGenerationStatus('running')

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      try {
        // Regenerate piggybacks on the most-recent snapshot for vision/image
        // model resolution. The pipeline data itself comes from lastPipelineState.
        const snapshot = snapshotFromStore()
        const analysisModel = resolveVisionModel(snapshot)
        const drawingModel = resolveImageModel(snapshot)
        if (!drawingModel) {
          throw new Error('未检测到绘图模型，请先在顶部模型选择器中选择生图模型')
        }
        if (analysisModel === drawingModel) {
          throw new Error('视觉模型与绘图模型不能混用，请分别设置"视觉模型(分析)"与顶部"绘图模型(出图)"')
        }
        store.setImageModel(drawingModel)

        const { getDirectorPipelineService } = await import('@/services/ServiceBridge')
        const pipeline = await getDirectorPipelineService(analysisModel)
        if (!pipeline) {
          throw new Error('导演模式初始化失败: 请确认已在「设置 → Vision API Key」中正确填写 API Key，且当前站点有效')
        }

        const result = await pipeline.regenerateImages(
          { ...prevState, imageModel: drawingModel },
          count,
          onProgress,
          { signal: abortController.signal },
        )

        const mappedImages = (result.images ?? []).map((img: any) => ({
          url: img.url,
          prompt: img.prompt,
          timestamp: Date.now(),
        }))

        useDirectorStore.getState().setGeneratedResults((prev) => [...prev, ...mappedImages])

        void saveToHistory(
          mappedImages,
          String((prevState as any).sceneDescription || ''),
          snapshot.currentRatio,
        )

        return result
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          console.log('[Director] 重新生成已取消')
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

  const canRegenerate = useDirectorStore((s) => s.lastPipelineState !== null) && !isGenerating

  // Back-compat alias: existing call sites use startGeneration. Map it to
  // enqueueGeneration which now provides the live-queue behaviour. Old
  // callers got Promise<void>; new callers can ignore the return value or
  // observe pendingCount / generationStatus to know when the job completes.
  const startGeneration = useCallback(
    async (
      onProgress?: (progress: PipelineProgress) => void,
      styleInstructions?: string,
    ): Promise<void> => {
      enqueueGeneration(onProgress, styleInstructions)
    },
    [enqueueGeneration],
  )

  return {
    canGenerate,
    canRegenerate,
    isGenerating,
    generationStatus,
    pendingCount,
    startGeneration,
    enqueueGeneration,
    regenerateImages,
    cancelGeneration,
    pauseGeneration,
    resumeGeneration,
    // Kept for back-compat with code that builds a layout config outside the hook.
    getLayoutConfig: useCallback((layout?: string) => {
      const snapshot = snapshotFromStore()
      return getLayoutConfigFor(snapshot, layout)
    }, []),
  }
}
