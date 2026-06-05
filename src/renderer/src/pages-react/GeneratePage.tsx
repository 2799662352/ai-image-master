import { useEffect, useRef, useMemo, useCallback } from 'react'
import { useModelStore, useToastStore, useGenerateStore } from '../stores'
import { useApi } from '../hooks/useService'
import type { GenerateSnapshot } from '../stores/useGenerateStore'
import { useAutosizeTextarea } from '../hooks/useAutosizeTextarea'
import { ModelSelector } from '../components/ModelSelector'
import { ImageParamControls } from '../react-app/components/ImageParamControls'
import { TemplateInline } from '../react-app/components/TemplateInline'
import { ReferenceImageList } from './generate/ReferenceImageList'
import { ResultGrid } from './generate/ResultGrid'
import type { MediaRef } from '../components/shared/media-tokens/types'
import { useTokenAutocomplete, TokenAutocomplete, MentionChips } from '../components/shared/media-tokens'
import '../components/shared/media-tokens/media-tokens.css'

export default function GeneratePage() {
  const api = useApi()
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const models = useModelStore((s) => s.models)
  const addToast = useToastStore((s) => s.addToast)

  const prompt = useGenerateStore((s) => s.prompt)
  const ratio = useGenerateStore((s) => s.ratio)
  const resolution = useGenerateStore((s) => s.resolution)
  const quality = useGenerateStore((s) => s.quality)
  const generating = useGenerateStore((s) => s.generating)
  const inFlightCount = useGenerateStore((s) => s.inFlightCount)
  const resultUrls = useGenerateStore((s) => s.resultUrls)
  const resultMeta = useGenerateStore((s) => s.resultMeta)
  const referenceImages = useGenerateStore((s) => s.referenceImages)
  const error = useGenerateStore((s) => s.error)

  const {
    setPrompt,
    setRatio,
    setResolution,
    setQuality,
    addReferenceImage,
    removeReferenceImage,
    clearResults,
    generate,
    restoreForEdit,
  } = useGenerateStore.getState()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const currentModel = models[currentModelKey]

  const genMediaRefs = useMemo<MediaRef[]>(
    () => referenceImages.map((url, i) => ({
      index: i + 1,
      type: 'image' as const,
      url,
      label: `图片${i + 1}`,
    })),
    [referenceImages],
  )

  const ac = useTokenAutocomplete({
    mediaRefs: genMediaRefs,
    textareaRef,
    value: prompt,
    onValueChange: setPrompt,
  })
  useAutosizeTextarea(textareaRef, prompt, { minRows: 4, maxRows: 20 })

  useEffect(() => {
    if (error) addToast({ message: error, type: 'error' })
  }, [error])

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      addToast({ message: '请输入提示词', type: 'warning' })
      return
    }
    if (!currentModelKey) {
      addToast({ message: '请选择模型', type: 'warning' })
      return
    }
    // Non-blocking: each click fires a concurrent generation. We do NOT clear
    // results — completed images stream into the grid below. Use the "清空"
    // button next to the grid to reset.
    const urlsBefore = useGenerateStore.getState().resultUrls.length
    await generate(api, currentModelKey)
    const urlsAfter = useGenerateStore.getState().resultUrls.length
    const added = urlsAfter - urlsBefore
    if (added > 0) {
      addToast({ message: `生成完成 (+${added} 张)`, type: 'success' })
    }
  }

  /**
   * 点 [重编辑] 按钮: 把对应结果的 snapshot 灌回表单。
   *
   * 用户已经在 generate 页, 不用切 tab。但要:
   * 1) 把 prompt/refs/ratio 写回表单, 并切换 model store
   * 2) 让 textarea 立刻看到新 prompt(setPrompt 已经走 store, autosize 自动跟随)
   * 3) toast 提示一下, 避免静默把表单刷掉用户看不到
   */
  const handleEditFromResult = useCallback((snapshot: GenerateSnapshot) => {
    restoreForEdit({
      prompt: snapshot.prompt,
      ratio: snapshot.ratio,
      referenceImages: snapshot.referenceImages,
    })
    if (snapshot.modelKey && models[snapshot.modelKey]) {
      useModelStore.getState().switchModel(snapshot.modelKey)
    }
    addToast({ type: 'success', message: '参数已恢复, 修改后再点生成 / RESTORED' })
  }, [restoreForEdit, models, addToast])

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') addReferenceImage(reader.result)
      }
      reader.readAsDataURL(file)
    })
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">🎨 AI 图片生成</h1>
        <ModelSelector />
      </div>

      {currentModel && (
        <div className="text-sm text-zinc-500">
          当前模型: <span className="text-cyberpunk-yellow">{currentModel.name}</span>
        </div>
      )}

      <TemplateInline context="generate" />

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={ac.handleChange}
          onKeyDown={ac.handleKeyDown}
          placeholder="描述你想要生成的图片... 输入 @ 引用参考图"
          rows={4}
          className="w-full px-4 py-3 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow resize-none transition-[height] duration-100"
        />
        <TokenAutocomplete
          visible={ac.visible}
          suggestions={ac.suggestions}
          selectedIndex={ac.selectedIndex}
          position={ac.position}
          theme="default"
          onSelect={ac.selectToken}
          onClose={ac.handleClose}
          onHover={ac.handleHover}
        />
        <MentionChips value={prompt} mediaRefs={genMediaRefs} theme="default" onValueChange={setPrompt} />
      </div>

      <ImageParamControls
        variant="cyberpunk"
        modelConfig={currentModel}
        ratio={ratio}
        onRatioChange={setRatio}
        resolution={resolution}
        onResolutionChange={setResolution}
        quality={quality}
        onQualityChange={setQuality}
      />

      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileUpload} />
      <ReferenceImageList
        images={referenceImages}
        onRemove={removeReferenceImage}
        onAdd={() => fileInputRef.current?.click()}
      />

      <button
        onClick={handleGenerate}
        disabled={!prompt.trim() || !currentModelKey}
        className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-lg uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
      >
        {generating ? `加入队列 (运行中 × ${inFlightCount})` : '开始生成'}
      </button>

      {resultUrls.length > 0 && (
        <div className="flex items-center justify-between border-t-2 border-zinc-800 pt-3">
          <span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">
            结果 · {resultUrls.length} 张{generating ? ` · 还有 ${inFlightCount} 个在生成` : ''}
          </span>
          <button
            type="button"
            onClick={clearResults}
            className="px-3 py-1 text-xs uppercase tracking-wider text-zinc-400 border border-zinc-700 hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow transition-colors"
          >
            清空
          </button>
        </div>
      )}

      <ResultGrid urls={resultUrls} meta={resultMeta} onEditFromResult={handleEditFromResult} />
    </div>
  )
}
