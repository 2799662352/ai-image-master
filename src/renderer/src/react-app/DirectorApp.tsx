import { useState, useCallback } from 'react'
import { ReferenceImageUpload } from './components/ReferenceImageUpload'
import { LayoutSelector } from './components/LayoutSelector'
import { SceneInput } from './components/SceneInput'
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="space-y-4">
          <ReferenceImageUpload />
          <LayoutSelector />
          <SceneInput />
          <GenerateButton onGenerate={handleGenerate} />
        </div>
        <div className="space-y-4">
          {viewState === 'idle' && generatedResults.length === 0 && (
            <div className="bg-[#27272A] rounded-none p-6 min-h-96 flex items-center justify-center">
              <div className="text-center text-white opacity-50">
                <i className="fas fa-film text-6xl mb-4 opacity-30" />
                <p>上传参考图并点击"一键生成"开始创作</p>
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
