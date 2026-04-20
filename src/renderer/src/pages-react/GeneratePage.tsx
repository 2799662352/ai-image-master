import { useEffect, useRef, useState, useCallback } from 'react'
import { useModelStore, useToastStore, useGenerateStore } from '../stores'
import { useUIPrefsStore } from '../stores/useUIPrefsStore'
import { useApi } from '../hooks/useService'
import { ModelSelector } from '../components/ModelSelector'
import { RatioSelector } from './generate/RatioSelector'
import { ReferenceImageList } from './generate/ReferenceImageList'
import { ResultGrid } from './generate/ResultGrid'
import ImageEditorModal from '../components/shared/image-editors/ImageEditorModal'
import '../components/shared/image-editors/image-editors.css'

export default function GeneratePage() {
  const api = useApi()
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const models = useModelStore((s) => s.models)
  const addToast = useToastStore((s) => s.addToast)

  const prompt = useGenerateStore((s) => s.prompt)
  const ratio = useGenerateStore((s) => s.ratio)
  const generating = useGenerateStore((s) => s.generating)
  const resultUrls = useGenerateStore((s) => s.resultUrls)
  const referenceImages = useGenerateStore((s) => s.referenceImages)
  const error = useGenerateStore((s) => s.error)

  const { setPrompt, setRatio, addReferenceImage, removeReferenceImage, clearResults, generate } =
    useGenerateStore.getState()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentModel = models[currentModelKey]

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
    clearResults()
    await generate(api, currentModelKey)
    const urls = useGenerateStore.getState().resultUrls
    if (urls.length > 0) {
      addToast({ message: `生成完成 (${urls.length} 张)`, type: 'success' })
    }
  }

  // ---- image editor ----
  const [editorState, setEditorState] = useState<{ url: string; type: 'angle' | 'light' } | null>(null)
  const toolbarEnabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)

  const injectPrompt = useCallback((p: string) => {
    const cur = useGenerateStore.getState().prompt
    setPrompt(cur + '\n' + p)
  }, [setPrompt])

  const openEditor = useCallback((url: string, type: 'angle' | 'light') => {
    setEditorState({ url, type })
  }, [])

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

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="描述你想要生成的图片..."
        rows={4}
        className="w-full px-4 py-3 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow resize-none"
      />

      {toolbarEnabled && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">提示词助手:</span>
          <button
            type="button"
            onClick={() => openEditor('', 'angle')}
            className="px-3 py-1 text-xs font-bold bg-zinc-700 hover:bg-zinc-600 text-white rounded-md transition-colors"
          >
            多角度
          </button>
          <button
            type="button"
            onClick={() => openEditor('', 'light')}
            className="px-3 py-1 text-xs font-bold bg-zinc-700 hover:bg-zinc-600 text-white rounded-md transition-colors"
          >
            打光
          </button>
        </div>
      )}

      <RatioSelector value={ratio} onChange={setRatio} />

      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileUpload} />
      <ReferenceImageList
        images={referenceImages}
        onRemove={removeReferenceImage}
        onAdd={() => fileInputRef.current?.click()}
      />

      <button
        onClick={handleGenerate}
        disabled={generating}
        className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-lg uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
      >
        {generating ? '生成中...' : '开始生成'}
      </button>

      <ResultGrid urls={resultUrls} onOpenEditor={openEditor} />

      {editorState && (
        <ImageEditorModal
          key={editorState.type}
          editorType={editorState.type}
          imageUrl={editorState.url}
          theme="default"
          onInjectPrompt={injectPrompt}
          onClose={() => setEditorState(null)}
        />
      )}
    </div>
  )
}
