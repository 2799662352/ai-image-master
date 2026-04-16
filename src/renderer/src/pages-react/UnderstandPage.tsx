import { useState, useCallback, useRef } from 'react'
import { useToastStore } from '../stores'

export default function UnderstandPage() {
  const addToast = useToastStore((s) => s.addToast)

  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [analysisResult, setAnalysisResult] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [question, setQuestion] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setImageUrl(reader.result)
    }
    reader.readAsDataURL(file)
  }, [])

  const handleAnalyze = useCallback(async () => {
    if (!imageUrl) {
      addToast({ message: '请先上传图片', type: 'warning' })
      return
    }
    setAnalyzing(true)
    setAnalysisResult('')
    try {
      const api = (window as any).aiImageAPI
      const result = await api?.analyzeImage?.({
        imageUrl,
        question: question.trim() || undefined,
      })
      setAnalysisResult(result?.text ?? '分析未返回结果')
    } catch {
      addToast({ message: '图像分析失败', type: 'error' })
    } finally {
      setAnalyzing(false)
    }
  }, [imageUrl, question, addToast])

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">🧠 图像理解</h1>

      {/* Upload area */}
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
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleImageUpload}
        />
      </div>

      {/* Question */}
      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="输入问题（可选，留空将自动分析）"
        className="w-full px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
      />

      <button
        onClick={handleAnalyze}
        disabled={analyzing || !imageUrl}
        className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
      >
        {analyzing ? '分析中...' : '开始分析'}
      </button>

      {/* Result */}
      {analysisResult && (
        <div className="bg-zinc-900 border-2 border-zinc-700 p-4">
          <h3 className="text-sm font-bold text-cyberpunk-yellow mb-2">分析结果</h3>
          <pre className="text-sm text-gray-300 whitespace-pre-wrap">{analysisResult}</pre>
        </div>
      )}
    </div>
  )
}
