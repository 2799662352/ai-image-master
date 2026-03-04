import { useCallback, useMemo, useRef, useState } from 'react'
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
import { detectVisionDetailPreset, useDirectorStore } from './stores/useDirectorStore'
import { getDirectorSkillLoadStats, getDirectorSkillsFromConfig, reloadDirectorSkills } from '../services/pipeline/prompt-loader'

const VISION_DETAIL_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'high', label: '高' },
  { value: 'auto', label: '自动' },
] as const

export function DirectorApp() {
  const [isRefreshingSkills, setIsRefreshingSkills] = useState(false)
  const [isVisionControlsCollapsed, setIsVisionControlsCollapsed] = useState(false)
  const isRefreshingSkillsRef = useRef(false)
  const viewState = useDirectorStore((s) => s.viewState)
  const generatedResults = useDirectorStore((s) => s.generatedResults)
  const skipVerify = useDirectorStore((s) => s.skipVerify)
  const scoreThreshold = useDirectorStore((s) => s.scoreThreshold)
  const visionDetailAnalyzeScene = useDirectorStore((s) => s.visionDetailAnalyzeScene)
  const visionDetailCharacterAnchors = useDirectorStore((s) => s.visionDetailCharacterAnchors)
  const visionDetailDesignAssemble = useDirectorStore((s) => s.visionDetailDesignAssemble)
  const visionDetailVerifyConsistency = useDirectorStore((s) => s.visionDetailVerifyConsistency)
  const setSkipVerify = useDirectorStore((s) => s.setSkipVerify)
  const setScoreThreshold = useDirectorStore((s) => s.setScoreThreshold)
  const setVisionDetailAnalyzeScene = useDirectorStore((s) => s.setVisionDetailAnalyzeScene)
  const setVisionDetailCharacterAnchors = useDirectorStore((s) => s.setVisionDetailCharacterAnchors)
  const setVisionDetailDesignAssemble = useDirectorStore((s) => s.setVisionDetailDesignAssemble)
  const setVisionDetailVerifyConsistency = useDirectorStore((s) => s.setVisionDetailVerifyConsistency)
  const skipAnalyzeScene = useDirectorStore((s) => s.skipAnalyzeScene)
  const skipCharacterAnchors = useDirectorStore((s) => s.skipCharacterAnchors)
  const setSkipAnalyzeScene = useDirectorStore((s) => s.setSkipAnalyzeScene)
  const setSkipCharacterAnchors = useDirectorStore((s) => s.setSkipCharacterAnchors)
  const applyVisionDetailPreset = useDirectorStore((s) => s.applyVisionDetailPreset)
  const setViewState = useDirectorStore((s) => s.setViewState)
  const pushProgress = useDirectorStore((s) => s.pushProgress)
  const resetProgress = useDirectorStore((s) => s.resetProgress)
  const setGeneratedResults = useDirectorStore((s) => s.setGeneratedResults)
  const { startGeneration, cancelGeneration, pauseGeneration, resumeGeneration, generationStatus } = useDirectorGeneration()
  const activePreset = useMemo(() => detectVisionDetailPreset({
    visionDetailAnalyzeScene,
    visionDetailCharacterAnchors,
    visionDetailDesignAssemble,
    visionDetailVerifyConsistency,
  }), [
    visionDetailAnalyzeScene,
    visionDetailCharacterAnchors,
    visionDetailDesignAssemble,
    visionDetailVerifyConsistency,
  ])

  const handleRefreshSkills = useCallback(async () => {
    if (isRefreshingSkillsRef.current) return
    isRefreshingSkillsRef.current = true
    setIsRefreshingSkills(true)
    try {
      await reloadDirectorSkills()
      const count = getDirectorSkillsFromConfig().length
      const stats = getDirectorSkillLoadStats()
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(
        `Skills 已刷新（总数 ${count}，用户 ${stats.userCount}，新增 ${stats.addedCount}，覆盖 ${stats.overriddenCount}）`,
        'success',
      )
    } catch (error: any) {
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(error?.message || '刷新 Skills 失败', 'error')
    } finally {
      isRefreshingSkillsRef.current = false
      setIsRefreshingSkills(false)
    }
  }, [])

  const handleOpenSkillsFolder = useCallback(async () => {
    try {
      const api = (window as any).electronAPI
      if (!api?.openSkillsFolder) {
        throw new Error('当前环境不支持打开 Skills 文件夹')
      }
      const result = await api.openSkillsFolder()
      if (!result?.success) {
        throw new Error(result?.error || '打开 Skills 文件夹失败')
      }
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      const tip = result?.path ? `已打开 Skills 文件夹：${result.path}` : '已打开 Skills 文件夹'
      toast?.show?.(tip, 'success')
    } catch (error: any) {
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(error?.message || '打开 Skills 文件夹失败', 'error')
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
          <div className="text-[11px] text-white/55">
            绘图模型(出图)：跟随顶部全局模型，影响图片尺寸与清晰度能力
          </div>
          <div className="flex items-center gap-3">
            <GenerateButton
              onGenerate={handleGenerate}
              onCancel={cancelGeneration}
              onPause={pauseGeneration}
              onResume={() => resumeGeneration((progress) => {
                pushProgress(progress as any)
                const evt = (progress as any)?.data
                if (evt?.type === 'image_generated' && typeof evt.url === 'string' && evt.url) {
                  const store = useDirectorStore.getState()
                  store.setGeneratedResults((prev) => [
                    ...prev,
                    { url: evt.url, prompt: typeof evt.prompt === 'string' ? evt.prompt : '', timestamp: Date.now() },
                  ])
                }
              })}
            />
            <button
              type="button"
              onClick={handleRefreshSkills}
              disabled={isRefreshingSkills}
              className="py-3 px-4 rounded-none border border-[#3F3F46] text-xs text-white/85 hover:text-white hover:border-[#52525B] transition-colors shrink-0"
            >
              {isRefreshingSkills ? '刷新中...' : '刷新 Skills'}
            </button>
            <button
              type="button"
              onClick={handleOpenSkillsFolder}
              className="py-3 px-4 rounded-none border border-[#3F3F46] text-xs text-white/85 hover:text-white hover:border-[#52525B] transition-colors shrink-0"
            >
              打开 Skills 文件夹
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
          <div className="border border-[#27272A] p-3">
            <div className="flex items-center justify-between text-xs text-white/80 mb-2">
              <span>一致性校验阈值</span>
              <span className="text-yellow-400 font-semibold">{scoreThreshold}</span>
            </div>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={scoreThreshold}
              onChange={(e) => setScoreThreshold(Number(e.target.value))}
              className="w-full accent-yellow-500"
              aria-label="一致性校验阈值"
              disabled={skipVerify}
            />
            <div className="mt-1 text-[11px] text-white/50">
              评分低于该值将触发重试（快速模式开启时跳过校验）
            </div>
          </div>

          <div className="border border-[#27272A] p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-white/80">看图质量（每阶段独立）</div>
              <button
                type="button"
                aria-expanded={!isVisionControlsCollapsed}
                aria-controls="director-vision-controls-body"
                aria-label={isVisionControlsCollapsed ? '展开看图质量设置' : '收起看图质量设置'}
                onClick={() => setIsVisionControlsCollapsed((v) => !v)}
                className="px-2 py-1 text-[11px] border border-[#3F3F46] text-white/70 hover:text-white hover:bg-[#18181B] transition-colors cursor-pointer"
              >
                {isVisionControlsCollapsed ? '展开' : '收起'}
              </button>
            </div>

            {!isVisionControlsCollapsed && (
              <div id="director-vision-controls-body" className="space-y-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => applyVisionDetailPreset('speed')}
                    aria-pressed={activePreset === 'speed'}
                    className={`px-2.5 py-1.5 text-[11px] border border-[#3F3F46] transition-colors cursor-pointer ${
                      activePreset === 'speed'
                        ? 'bg-yellow-500 text-black font-semibold'
                        : 'bg-[#09090B] text-white/75 hover:text-white hover:bg-[#18181B]'
                    }`}
                  >
                    一键预设：省时
                  </button>
                  <button
                    type="button"
                    onClick={() => applyVisionDetailPreset('balanced')}
                    aria-pressed={activePreset === 'balanced'}
                    className={`px-2.5 py-1.5 text-[11px] border border-[#3F3F46] transition-colors cursor-pointer ${
                      activePreset === 'balanced'
                        ? 'bg-yellow-500 text-black font-semibold'
                        : 'bg-[#09090B] text-white/75 hover:text-white hover:bg-[#18181B]'
                    }`}
                  >
                    一键预设：平衡
                  </button>
                  <button
                    type="button"
                    onClick={() => applyVisionDetailPreset('quality')}
                    aria-pressed={activePreset === 'quality'}
                    className={`px-2.5 py-1.5 text-[11px] border border-[#3F3F46] transition-colors cursor-pointer ${
                      activePreset === 'quality'
                        ? 'bg-yellow-500 text-black font-semibold'
                        : 'bg-[#09090B] text-white/75 hover:text-white hover:bg-[#18181B]'
                    }`}
                  >
                    一键预设：质量
                  </button>
                </div>

                {[
                  { key: 'analyze', label: '场景分析', value: visionDetailAnalyzeScene, onChange: setVisionDetailAnalyzeScene, skippable: true, skipped: skipAnalyzeScene, onToggleSkip: setSkipAnalyzeScene, skipLabel: '跳过场景分析' },
                  { key: 'anchor', label: '角色锚定', value: visionDetailCharacterAnchors, onChange: setVisionDetailCharacterAnchors, skippable: true, skipped: skipCharacterAnchors, onToggleSkip: setSkipCharacterAnchors, skipLabel: '跳过角色锚定' },
                  { key: 'design', label: '分镜+Prompt', value: visionDetailDesignAssemble, onChange: setVisionDetailDesignAssemble, skippable: false, skipped: false, onToggleSkip: undefined as ((v: boolean) => void) | undefined, skipLabel: '' },
                  { key: 'verify', label: '一致性校验', value: visionDetailVerifyConsistency, onChange: setVisionDetailVerifyConsistency, skippable: true, skipped: skipVerify, onToggleSkip: setSkipVerify, skipLabel: '跳过一致性校验' },
                ].map((item) => (
                  <div key={item.key} className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {item.skippable ? (
                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                          <input
                            type="checkbox"
                            checked={!item.skipped}
                            onChange={() => item.onToggleSkip?.(!item.skipped)}
                            className="sr-only peer"
                            aria-label={item.skipLabel}
                          />
                          <div className="w-7 h-4 bg-[#3F3F46] rounded-full peer peer-checked:bg-yellow-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-3" />
                        </label>
                      ) : (
                        <span className="text-[9px] text-white/35 w-7 text-center shrink-0">必需</span>
                      )}
                      <span className={`text-[11px] whitespace-nowrap ${item.skipped ? 'text-white/30 line-through' : 'text-white/65'}`}>
                        {item.label}
                      </span>
                    </div>
                    <div className="inline-flex border border-[#3F3F46]">
                      {VISION_DETAIL_OPTIONS.map((option) => {
                        const active = item.value === option.value
                        const disabled = item.skipped
                        return (
                          <button
                            key={`${item.key}-${option.value}`}
                            type="button"
                            onClick={() => !disabled && item.onChange(option.value)}
                            aria-pressed={active}
                            disabled={disabled}
                            className={`px-2.5 py-1.5 text-[11px] transition-colors ${
                              disabled
                                ? 'bg-[#09090B] text-white/20 cursor-not-allowed'
                                : active
                                  ? 'bg-yellow-500 text-black font-semibold cursor-pointer'
                                  : 'bg-[#09090B] text-white/70 hover:text-white hover:bg-[#18181B] cursor-pointer'
                            }`}
                          >
                            {option.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
                <div className="text-[11px] text-white/45">
                  建议：跳过阶段可加速生成，但会降低出图一致性。分镜+Prompt 为必需阶段不可跳过。
                </div>
              </div>
            )}
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
          {generationStatus === 'paused' && (
            <div className="text-amber-400 text-sm mt-2 flex items-center gap-2">
              <i className="fas fa-pause-circle" />
              已暂停 — 点击「继续」恢复生成
            </div>
          )}
          {(viewState === 'generating' || generatedResults.length > 0) && (
            <ResultsGallery />
          )}
        </div>
      </div>
    </div>
  )
}
