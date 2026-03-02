import { useCallback, useRef, useState } from 'react'
import { ReferenceImageUpload } from './components/ReferenceImageUpload'
import { ModeSelector } from './components/ModeSelector'
import { TemplateSelector } from './components/TemplateSelector'
import { SceneInput } from './components/SceneInput'
import { LayoutSelector } from './components/LayoutSelector'
import { ImageCountSlider } from './components/ImageCountSlider'
import { RatioResolutionSelector } from './components/RatioResolutionSelector'
import { GenerateButton } from './components/GenerateButton'
import { GenerationProgress } from './components/GenerationProgress'
import { ResultsGallery } from './components/ResultsGallery'
import { useDirectorGeneration } from './hooks/useDirectorGeneration'
import { useDirectorStore } from './stores/useDirectorStore'
import { getDirectorSkillsFromConfig, reloadDirectorSkills } from '../services/pipeline/prompt-loader'

export function DirectorApp() {
  const [isRefreshingSkills, setIsRefreshingSkills] = useState(false)
  const isRefreshingSkillsRef = useRef(false)
  const viewState = useDirectorStore((s) => s.viewState)
  const generatedResults = useDirectorStore((s) => s.generatedResults)
  const skipVerify = useDirectorStore((s) => s.skipVerify)
  const setSkipVerify = useDirectorStore((s) => s.setSkipVerify)
  const setViewState = useDirectorStore((s) => s.setViewState)
  const pushProgress = useDirectorStore((s) => s.pushProgress)
  const resetProgress = useDirectorStore((s) => s.resetProgress)
  const setGeneratedResults = useDirectorStore((s) => s.setGeneratedResults)
  const { startGeneration } = useDirectorGeneration()

  const handleRefreshSkills = useCallback(async () => {
    if (isRefreshingSkillsRef.current) return
    isRefreshingSkillsRef.current = true
    setIsRefreshingSkills(true)
    try {
      await reloadDirectorSkills()
      const count = getDirectorSkillsFromConfig().length
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(`Skills 已刷新（${count}）`, 'success')
    } catch (error: any) {
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(error?.message || '刷新 Skills 失败', 'error')
    } finally {
      isRefreshingSkillsRef.current = false
      setIsRefreshingSkills(false)
    }
  }, [])

  const handleGenerate = useCallback(async () => {
    setViewState('generating')
    resetProgress()
    setGeneratedResults([])
    try {
      await startGeneration((progress) => {
        pushProgress(progress as any)

        // 图像流式回调：单张成功后立即显示，无需等待整个 pipeline 结束
        const evt = (progress as any)?.data
        if (evt?.type === 'image_generated' && typeof evt.url === 'string' && evt.url) {
          const store = useDirectorStore.getState()
          store.setGeneratedResults((prev) => {
            const exists = prev.some((r) => r.url === evt.url)
            if (exists) return prev
            return [
              ...prev,
              {
                url: evt.url,
                prompt: typeof evt.prompt === 'string' ? evt.prompt : '',
                timestamp: Date.now(),
              },
            ]
          })
        }
      })
      setViewState('results')
    } catch (error: any) {
      console.error('[DirectorApp] Generation failed:', error)
      setViewState('idle')
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(error.message || '生成失败', 'error')
    }
  }, [startGeneration, setViewState, pushProgress, resetProgress, setGeneratedResults])

  return (
    <div className="relative z-10">
      <div className="text-[12rem] font-black absolute -right-8 -top-8 opacity-[0.03] select-none pointer-events-none z-0 leading-none" aria-hidden="true">06</div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Left column: reference images + config */}
        <div className="space-y-4">
          <ReferenceImageUpload />
          <ModeSelector />
          <TemplateSelector />
          <SceneInput />
        </div>

        {/* Right column: layout + params + generate + results */}
        <div className="space-y-4">
          <LayoutSelector />
          <ImageCountSlider />
          <RatioResolutionSelector />
          <div className="flex items-center gap-3">
            <GenerateButton onGenerate={handleGenerate} />
            <button
              type="button"
              onClick={handleRefreshSkills}
              disabled={isRefreshingSkills}
              className="py-3 px-4 rounded-none border border-[#3F3F46] text-xs text-white/85 hover:text-white hover:border-[#52525B] transition-colors shrink-0"
            >
              {isRefreshingSkills ? '刷新中...' : '刷新 Skills'}
            </button>
            <label className="flex items-center gap-2 cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                checked={skipVerify}
                onChange={(e) => setSkipVerify(e.target.checked)}
                className="w-4 h-4 rounded border-[#3F3F46] bg-[#09090B] text-yellow-500 focus:ring-yellow-500/30"
              />
              <span className="text-xs text-white opacity-60 whitespace-nowrap">
                <i className="fas fa-bolt text-yellow-500 mr-1" />快速模式
              </span>
            </label>
          </div>

          {viewState === 'idle' && generatedResults.length === 0 && (
            <div className="bg-[#27272A] rounded-none p-6 flex items-center justify-center" style={{ minHeight: '200px' }}>
              <div className="text-center text-white opacity-50">
                <i className="fas fa-film text-4xl mb-3 opacity-30" />
                <p className="text-sm">上传参考图并点击"一键生成"开始创作</p>
              </div>
            </div>
          )}
          {(viewState === 'generating' || viewState === 'results') && (
            <GenerationProgress collapsed={viewState === 'results'} />
          )}
          {generatedResults.length > 0 && (
            <ResultsGallery />
          )}
        </div>
      </div>
    </div>
  )
}
