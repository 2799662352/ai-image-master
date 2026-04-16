import { useState, useCallback } from 'react'
import { useModelStore, useToastStore } from '../stores'

interface BatchItem {
  id: number
  prompt: string
  status: 'pending' | 'generating' | 'done' | 'error'
  resultUrl?: string
  error?: string
}

let nextId = 1

export default function BatchPage() {
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const addToast = useToastStore((s) => s.addToast)

  const [items, setItems] = useState<BatchItem[]>([])
  const [newPrompt, setNewPrompt] = useState('')
  const [running, setRunning] = useState(false)

  const addItem = useCallback(() => {
    if (!newPrompt.trim()) return
    setItems((prev) => [...prev, { id: nextId++, prompt: newPrompt.trim(), status: 'pending' }])
    setNewPrompt('')
  }, [newPrompt])

  const removeItem = useCallback((id: number) => {
    setItems((prev) => prev.filter((i) => i.id !== id))
  }, [])

  const handleBulkAdd = useCallback((text: string) => {
    const lines = text.split('\n').filter((l) => l.trim())
    const newItems = lines.map((line) => ({
      id: nextId++,
      prompt: line.trim(),
      status: 'pending' as const,
    }))
    setItems((prev) => [...prev, ...newItems])
  }, [])

  const runBatch = useCallback(async () => {
    if (!currentModelKey) {
      addToast({ message: '请先选择模型', type: 'warning' })
      return
    }
    const pending = items.filter((i) => i.status === 'pending')
    if (pending.length === 0) {
      addToast({ message: '没有待处理的任务', type: 'warning' })
      return
    }

    setRunning(true)
    const api = (window as any).aiImageAPI

    for (const item of pending) {
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, status: 'generating' } : i))
      )
      try {
        const result = await api?.generate?.({ prompt: item.prompt, model: currentModelKey })
        setItems((prev) =>
          prev.map((i) =>
            i.id === item.id
              ? { ...i, status: 'done', resultUrl: result?.urls?.[0] }
              : i
          )
        )
      } catch (e: any) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === item.id ? { ...i, status: 'error', error: e?.message } : i
          )
        )
      }
    }
    setRunning(false)
    addToast({ message: '批量生成完成', type: 'success' })
  }, [items, currentModelKey, addToast])

  const doneCount = items.filter((i) => i.status === 'done').length

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">📦 批量生成</h1>
        <span className="text-sm text-zinc-500">
          {doneCount}/{items.length} 完成
        </span>
      </div>

      {/* Add prompt */}
      <div className="flex gap-2">
        <input
          value={newPrompt}
          onChange={(e) => setNewPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addItem()}
          placeholder="输入提示词，回车添加..."
          className="flex-1 px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
        />
        <button
          onClick={addItem}
          className="px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-cyberpunk-yellow hover:bg-zinc-700 transition-colors"
        >
          添加
        </button>
      </div>

      {/* Bulk add */}
      <details className="text-sm">
        <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300">批量导入（每行一个提示词）</summary>
        <textarea
          rows={4}
          placeholder="粘贴多行提示词..."
          className="w-full mt-2 px-3 py-2 bg-zinc-800 border border-zinc-700 text-white text-sm resize-none focus:outline-none focus:border-cyberpunk-yellow"
          onBlur={(e) => {
            if (e.target.value.trim()) {
              handleBulkAdd(e.target.value)
              e.target.value = ''
            }
          }}
        />
      </details>

      {/* Task list */}
      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {items.map((item) => (
          <div
            key={item.id}
            className={`flex items-center gap-3 p-3 border-2 ${
              item.status === 'done'
                ? 'border-green-700 bg-green-900/10'
                : item.status === 'error'
                  ? 'border-red-700 bg-red-900/10'
                  : item.status === 'generating'
                    ? 'border-cyberpunk-yellow/50 bg-cyberpunk-yellow/5'
                    : 'border-zinc-700 bg-zinc-900'
            }`}
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-300 truncate">{item.prompt}</p>
              {item.error && <p className="text-xs text-red-400 mt-1">{item.error}</p>}
            </div>
            {item.resultUrl && (
              <img src={item.resultUrl} alt="" className="w-10 h-10 object-cover border border-zinc-700" />
            )}
            {item.status === 'generating' && (
              <div className="w-4 h-4 border-2 border-cyberpunk-yellow border-t-transparent rounded-full animate-spin" />
            )}
            <button
              onClick={() => removeItem(item.id)}
              className="text-zinc-600 hover:text-red-400 text-sm"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Run */}
      {items.length > 0 && (
        <button
          onClick={runBatch}
          disabled={running}
          className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
        >
          {running ? `批量生成中... (${doneCount}/${items.length})` : '开始批量生成'}
        </button>
      )}
    </div>
  )
}
