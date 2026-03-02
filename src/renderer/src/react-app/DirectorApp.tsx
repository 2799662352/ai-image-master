import { useState, useCallback } from 'react'
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
import type { PipelineProgress } from '../services/pipeline/types'

type ViewState = 'idle' | 'generating' | 'results'

export function DirectorApp() {
  const [viewState, setViewState] = useState<ViewState>('idle')
  const [currentProgress, setCurrentProgress] = useState<PipelineProgress | null>(null)
  const generatedResults = useDirectorStore((s) => s.generatedResults)
  const { startGeneration } = useDirectorGeneration()

  const handleGenerate = useCallback(async () => {
    setViewState('generating')
    setCurrentProgress(null)
    try {
      await startGeneration((progress) => {
        setCurrentProgress(progress)
      })
      setViewState('results')
    } catch (error: any) {
      console.error('[DirectorApp] Generation failed:', error)
      setViewState('idle')
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(error.message || '生成失败', 'error')
    }
  }, [startGeneration])

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
          <GenerateButton onGenerate={handleGenerate} />

          {viewState === 'idle' && generatedResults.length === 0 && (
            <div className="bg-[#27272A] rounded-none p-6 flex items-center justify-center" style={{ minHeight: '200px' }}>
              <div className="text-center text-white opacity-50">
                <i className="fas fa-film text-4xl mb-3 opacity-30" />
                <p className="text-sm">上传参考图并点击"一键生成"开始创作</p>
              </div>
            </div>
          )}
          {viewState === 'generating' && (
            <GenerationProgress progress={currentProgress} />
          )}
          {(viewState === 'results' || generatedResults.length > 0) && viewState !== 'generating' && (
            <ResultsGallery />
          )}
        </div>
      </div>
    </div>
  )
}
