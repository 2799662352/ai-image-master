import { useCallback } from 'react'
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

export function DirectorApp() {
  const viewState = useDirectorStore((s) => s.viewState)
  const generatedResults = useDirectorStore((s) => s.generatedResults)
  const skipVerify = useDirectorStore((s) => s.skipVerify)
  const setSkipVerify = useDirectorStore((s) => s.setSkipVerify)
  const setViewState = useDirectorStore((s) => s.setViewState)
  const pushProgress = useDirectorStore((s) => s.pushProgress)
  const resetProgress = useDirectorStore((s) => s.resetProgress)
  const { startGeneration } = useDirectorGeneration()

  const handleGenerate = useCallback(async () => {
    setViewState('generating')
    resetProgress()
    try {
      await startGeneration((progress) => {
        pushProgress(progress as any)
      })
      setViewState('results')
    } catch (error: any) {
      console.error('[DirectorApp] Generation failed:', error)
      setViewState('idle')
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(error.message || '生成失败', 'error')
    }
  }, [startGeneration, setViewState, pushProgress, resetProgress])

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
          {viewState === 'generating' && (
            <GenerationProgress />
          )}
          {(viewState === 'results' || generatedResults.length > 0) && viewState !== 'generating' && (
            <ResultsGallery />
          )}
        </div>
      </div>
    </div>
  )
}
