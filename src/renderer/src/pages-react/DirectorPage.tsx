import { useState, useCallback, useRef } from 'react'
import { useModelStore, useToastStore } from '../stores'
import { useUIPrefsStore } from '../stores/useUIPrefsStore'
import { useApi } from '../hooks/useService'
import { ModelSelector } from '../components/ModelSelector'
import ImageEditToolbar from '../components/shared/image-editors/ImageEditToolbar'
import ImageEditorModal from '../components/shared/image-editors/ImageEditorModal'
import '../components/shared/image-editors/image-editors.css'

export default function DirectorPage() {
  const api = useApi()
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const addToast = useToastStore((s) => s.addToast)
  const toolbarEnabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)

  const [prompt, setPrompt] = useState('')
  const [refImages, setRefImages] = useState<string[]>([])
  const [resultUrls, setResultUrls] = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [editorState, setEditorState] = useState<{ url: string; type: 'angle' | 'light' } | null>(null)

  const injectPrompt = useCallback((p: string) => {
    setPrompt((cur) => cur + '\n' + p)
  }, [])

  const openEditor = useCallback((url: string, type: 'angle' | 'light') => {
    setEditorState({ url, type })
  }, [])

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') setRefImages((prev) => [...prev, reader.result as string])
      }
      reader.readAsDataURL(file)
    })
  }

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      addToast({ message: '请输入提示词', type: 'warning' })
      return
    }
    if (!currentModelKey) {
      addToast({ message: '请先选择模型', type: 'warning' })
      return
    }
    setGenerating(true)
    setResultUrls([])
    try {
      const result = await api.generateImage({
        prompt,
        ratio: '1:1',
        model: currentModelKey,
        referenceImages: refImages.length > 0 ? refImages : undefined,
      })
      const urls = result.urls ?? result.images ?? []
      setResultUrls(urls)
      if (urls.length > 0) addToast({ message: `生成完成 (${urls.length} 张)`, type: 'success' })
    } catch (err) {
      addToast({ message: `生成失败: ${err instanceof Error ? err.message : String(err)}`, type: 'error' })
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">Director 测试区</h1>
        <ModelSelector />
      </div>

      <p className="text-xs text-zinc-500">
        上传参考图 → 使用编辑器构建提示词 → 点击生成
      </p>

      {/* Reference images */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-400">参考图</span>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="px-3 py-1 text-xs font-bold bg-zinc-700 hover:bg-zinc-600 text-white rounded-md transition-colors"
          >
            + 上传
          </button>
          {refImages.length > 0 && (
            <button
              type="button"
              onClick={() => setRefImages([])}
              className="px-3 py-1 text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-md transition-colors"
            >
              清空
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileUpload} />
        {refImages.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {refImages.map((img, i) => (
              <div key={i} className="group relative w-20 h-20 border border-zinc-700 bg-zinc-900 overflow-hidden">
                <img src={img} alt={`ref ${i + 1}`} className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => setRefImages((prev) => prev.filter((_, idx) => idx !== i))}
                  className="absolute top-0 right-0 w-5 h-5 bg-red-600 text-white text-xs font-bold opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Prompt textarea */}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="描述你想要生成的图片..."
        rows={5}
        className="w-full px-4 py-3 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow resize-none"
      />

      {/* Editor buttons */}
      {toolbarEnabled && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">提示词助手:</span>
          <button
            type="button"
            onClick={() => openEditor(refImages[0] ?? '', 'angle')}
            className="px-3 py-1 text-xs font-bold bg-zinc-700 hover:bg-zinc-600 text-white rounded-md transition-colors"
          >
            多角度
          </button>
          <button
            type="button"
            onClick={() => openEditor(refImages[0] ?? '', 'light')}
            className="px-3 py-1 text-xs font-bold bg-zinc-700 hover:bg-zinc-600 text-white rounded-md transition-colors"
          >
            打光
          </button>
        </div>
      )}

      {/* Generate */}
      <button
        onClick={handleGenerate}
        disabled={generating}
        className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-lg uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
      >
        {generating ? '生成中...' : '开始生成'}
      </button>

      {/* Result grid */}
      {resultUrls.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          {resultUrls.map((url, i) => (
            <div key={i} className="group relative bg-zinc-900 border-2 border-zinc-700 overflow-hidden">
              <ImageEditToolbar
                theme="default"
                imageUrl={url}
                onOpenEditor={(type) => openEditor(url, type)}
              />
              <img src={url} alt={`Result ${i + 1}`} className="w-full object-contain" />
            </div>
          ))}
        </div>
      )}

      {/* Editor modal */}
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
