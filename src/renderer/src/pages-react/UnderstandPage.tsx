import { useEffect, useRef } from 'react'
import { useToastStore, useUnderstandStore } from '../stores'
import { useApi } from '../hooks/useService'

export default function UnderstandPage() {
  const api = useApi()
  const addToast = useToastStore((s) => s.addToast)

  const imageUrl = useUnderstandStore((s) => s.imageUrl)
  const question = useUnderstandStore((s) => s.question)
  const analysisResult = useUnderstandStore((s) => s.analysisResult)
  const analyzing = useUnderstandStore((s) => s.analyzing)
  const inFlightCount = useUnderstandStore((s) => s.inFlightCount)
  const error = useUnderstandStore((s) => s.error)

  const { setImageUrl, setQuestion, analyze } = useUnderstandStore.getState()
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (error) addToast({ message: error, type: 'error' })
  }, [error])

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setImageUrl(reader.result)
    }
    reader.readAsDataURL(file)
  }

  const handleAnalyze = async () => {
    if (!imageUrl) {
      addToast({ message: '请先上传图片', type: 'warning' })
      return
    }
    await analyze(api)
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">🧠 图像理解</h1>

      <div
        className="border-2 border-dashed border-zinc-700 hover:border-cyberpunk-yellow/50 p-8 text-center cursor-pointer transition-colors"
        onClick={() => fileInputRef.current?.click()}
      >
        {imageUrl ? (
          <img src={imageUrl} alt="Uploaded" className="max-h-64 mx-auto object-contain" />
        ) : (
          <div className="text-zinc-500">
            <p className="text-4xl mb-2">📷</p>
            <p>点击或拖拽上传图片</p>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
      </div>

      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="输入问题（可选，留空将自动分析）"
        className="w-full px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
      />

      <button
        onClick={handleAnalyze}
        disabled={!imageUrl}
        className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
      >
        {analyzing ? `再次分析 (运行中 × ${inFlightCount})` : '开始分析'}
      </button>

      {analysisResult && (
        <div className="bg-zinc-900 border-2 border-zinc-700 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-cyberpunk-yellow">分析结果</h3>
            {analyzing && (
              <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider">
                新分析中 · {inFlightCount} 个待返回
              </span>
            )}
          </div>
          <pre className="text-sm text-gray-300 whitespace-pre-wrap">{analysisResult}</pre>
        </div>
      )}
    </div>
  )
}
