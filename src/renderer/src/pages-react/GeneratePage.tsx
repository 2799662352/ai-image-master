import { useState, useCallback, useRef } from 'react'
import { useModelStore, useToastStore } from '../stores'
import { ModelSelector } from '../components/ModelSelector'

export default function GeneratePage() {
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const models = useModelStore((s) => s.models)
  const addToast = useToastStore((s) => s.addToast)

  const [prompt, setPrompt] = useState('')
  const [ratio, setRatio] = useState('1:1')
  const [generating, setGenerating] = useState(false)
  const [resultUrls, setResultUrls] = useState<string[]>([])
  const [referenceImages, setReferenceImages] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const currentModel = models[currentModelKey]
  const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) {
      addToast({ message: '请输入提示词', type: 'warning' })
      return
    }
    if (!currentModelKey) {
      addToast({ message: '请选择模型', type: 'warning' })
      return
    }
    setGenerating(true)
    setResultUrls([])
    try {
      const api = (window as any).aiImageAPI
      const result = await api?.generate?.({
        prompt,
        ratio,
        model: currentModelKey,
        referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      })
      if (result?.urls?.length) {
        setResultUrls(result.urls)
        addToast({ message: `生成完成 (${result.urls.length} 张)`, type: 'success' })
      } else {
        addToast({ message: '生成失败，请检查配置', type: 'error' })
      }
    } catch (e: any) {
      addToast({ message: e?.message ?? '生成失败', type: 'error' })
    } finally {
      setGenerating(false)
    }
  }, [prompt, ratio, currentModelKey, referenceImages, addToast])

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    Array.from(files).forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setReferenceImages((prev) => [...prev, reader.result as string])
        }
      }
      reader.readAsDataURL(file)
    })
  }, [])

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

      {/* Prompt */}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="描述你想要生成的图片..."
        rows={4}
        className="w-full px-4 py-3 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow resize-none"
      />

      {/* Ratio selector */}
      <div className="flex flex-wrap gap-2">
        {ratios.map((r) => (
          <button
            key={r}
            onClick={() => setRatio(r)}
            className={`px-3 py-1.5 text-sm border-2 transition-colors ${
              ratio === r
                ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/10 text-cyberpunk-yellow'
                : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      {/* Reference images */}
      <div>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="text-sm text-zinc-400 hover:text-cyberpunk-yellow transition-colors"
        >
          + 添加参考图
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileUpload}
        />
        {referenceImages.length > 0 && (
          <div className="flex gap-2 mt-2 flex-wrap">
            {referenceImages.map((img, i) => (
              <div key={i} className="relative w-16 h-16">
                <img src={img} alt="" className="w-full h-full object-cover border border-zinc-700" />
                <button
                  onClick={() => setReferenceImages((prev) => prev.filter((_, idx) => idx !== i))}
                  className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Generate button */}
      <button
        onClick={handleGenerate}
        disabled={generating}
        className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-lg uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
      >
        {generating ? '生成中...' : '开始生成'}
      </button>

      {/* Results */}
      {resultUrls.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          {resultUrls.map((url, i) => (
            <div key={i} className="bg-zinc-900 border-2 border-zinc-700 overflow-hidden">
              <img src={url} alt={`Result ${i + 1}`} className="w-full object-contain" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
