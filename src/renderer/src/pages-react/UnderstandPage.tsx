import { useEffect, useRef, useState } from 'react'
import { useToastStore, useUnderstandStore } from '../stores'
import { useApi } from '../hooks/useService'
import { uploadRefImageOriginalFirst } from '../utils/refImageUpload'

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
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [urlMode, setUrlMode] = useState(false)
  const [urlInput, setUrlInput] = useState('')

  useEffect(() => {
    if (error) addToast({ message: error, type: 'error' })
  }, [error])

  // 原图直传 COS → 存 URL(理解端点直接吃 image_url URL,省掉大 base64 payload);
  // COS 不可用 / 失败时降级本地 base64,理解仍可进行。
  const ingestFile = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) {
      addToast({ message: `不是图片文件: ${file.name}`, type: 'error' })
      return
    }
    setUploading(true)
    const outcome = await uploadRefImageOriginalFirst(file, {
      metadata: { source: 'understand-upload', fileName: file.name },
    })
    setUploading(false)
    if (!outcome.ok) {
      addToast({ message: `读取失败: ${file.name}`, type: 'error' })
      return
    }
    setImageUrl(outcome.src)
    if (outcome.viaCos) {
      addToast({ message: '已上传原图到云端', type: 'success', duration: 1800 })
    }
  }

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) void ingestFile(file)
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (uploading) return
    const file = e.dataTransfer.files?.[0]
    if (file) void ingestFile(file)
  }

  /** 用图片链接(含 COS 历史图 URL)当理解输入。<img> 探活校验,直接存 URL。 */
  const addUrl = (raw: string): void => {
    const url = raw.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) {
      addToast({ message: '请填 http(s):// 开头的图片链接', type: 'error' })
      return
    }
    setUploading(true)
    const probe = new Image()
    const timer = setTimeout(() => {
      probe.onload = probe.onerror = null
      setUploading(false)
      addToast({ message: '图片加载超时(链接失效 / 跨域?)', type: 'error', duration: 3000 })
    }, 15_000)
    probe.onload = () => {
      clearTimeout(timer)
      setUploading(false)
      setImageUrl(url)
      setUrlInput('')
      setUrlMode(false)
      addToast({ message: '已用链接图片', type: 'success', duration: 1800 })
    }
    probe.onerror = () => {
      clearTimeout(timer)
      setUploading(false)
      addToast({ message: '图片无法加载(链接失效 / 跨域 / 非图片)', type: 'error', duration: 3000 })
    }
    probe.src = url
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
        className={`border-2 border-dashed p-8 text-center transition-colors ${
          dragOver
            ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/5'
            : uploading
              ? 'border-zinc-700 opacity-60 cursor-wait'
              : 'border-zinc-700 hover:border-cyberpunk-yellow/50 cursor-pointer'
        }`}
        onClick={() => !uploading && fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          if (!uploading) setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          setDragOver(false)
        }}
        onDrop={handleDrop}
      >
        {uploading ? (
          <div className="text-cyberpunk-yellow">
            <p className="text-4xl mb-2 animate-pulse">☁</p>
            <p className="font-mono text-xs uppercase tracking-wider">上传原图到云端…</p>
          </div>
        ) : imageUrl ? (
          <img src={imageUrl} alt="Uploaded" className="max-h-64 mx-auto object-contain" />
        ) : (
          <div className="text-zinc-500">
            <p className="text-4xl mb-2">📷</p>
            <p>点击或拖拽上传图片</p>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setUrlMode((v) => !v)}
          className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 hover:text-cyberpunk-yellow transition-colors"
        >
          {urlMode ? '× 收起链接' : '+ 粘贴图片链接'}
        </button>
        {urlMode && (
          <div className="flex gap-2">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addUrl(urlInput)
              }}
              placeholder="https://… 图片直链(支持 COS 历史图)"
              disabled={uploading}
              className="flex-1 px-3 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 text-sm focus:outline-none focus:border-cyberpunk-yellow disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => addUrl(urlInput)}
              disabled={uploading || !urlInput.trim()}
              className="px-4 py-2 border-2 border-zinc-700 bg-zinc-900 text-zinc-200 font-mono text-[11px] uppercase tracking-wider hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow transition-colors disabled:opacity-50"
            >
              添加
            </button>
          </div>
        )}
      </div>

      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="输入问题（可选，留空将自动分析）"
        className="w-full px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
      />

      <button
        onClick={handleAnalyze}
        disabled={!imageUrl || uploading}
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
