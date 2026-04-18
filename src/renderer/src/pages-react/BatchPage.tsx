import { useState, useMemo } from 'react'
import { useModelStore, useToastStore, useBatchStore } from '../stores'
import { useApi } from '../hooks/useService'
import { BatchItemRow } from './batch/BatchItemRow'
import { BulkAddPanel } from './batch/BulkAddPanel'

export default function BatchPage() {
  const api = useApi()
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const addToast = useToastStore((s) => s.addToast)

  const items = useBatchStore((s) => s.items)
  const running = useBatchStore((s) => s.running)
  const { addItem, removeItem, bulkAdd, runBatch } = useBatchStore.getState()

  const [newPrompt, setNewPrompt] = useState('')

  const doneCount = useMemo(() => items.filter((i) => i.status === 'done').length, [items])

  const handleAdd = () => {
    if (!newPrompt.trim()) return
    addItem(newPrompt.trim())
    setNewPrompt('')
  }

  const handleRunBatch = async () => {
    if (!currentModelKey) {
      addToast({ message: '请先选择模型', type: 'warning' })
      return
    }
    if (items.filter((i) => i.status === 'pending').length === 0) {
      addToast({ message: '没有待处理的任务', type: 'warning' })
      return
    }
    await runBatch(api, currentModelKey)
    addToast({ message: '批量生成完成', type: 'success' })
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">📦 批量生成</h1>
        <span className="text-sm text-zinc-500">{doneCount}/{items.length} 完成</span>
      </div>

      <div className="flex gap-2">
        <input
          value={newPrompt}
          onChange={(e) => setNewPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="输入提示词，回车添加..."
          className="flex-1 px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
        />
        <button
          onClick={handleAdd}
          className="px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-cyberpunk-yellow hover:bg-zinc-700 transition-colors"
        >
          添加
        </button>
      </div>

      <BulkAddPanel onBulkAdd={bulkAdd} />

      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {items.map((item) => (
          <BatchItemRow key={item.id} item={item} onRemove={removeItem} />
        ))}
      </div>

      {items.length > 0 && (
        <button
          onClick={handleRunBatch}
          disabled={running}
          className="w-full py-3 bg-cyberpunk-yellow text-cyberpunk-black font-bold uppercase tracking-tight hover:opacity-90 transition-all disabled:opacity-50"
        >
          {running ? `批量生成中... (${doneCount}/${items.length})` : '开始批量生成'}
        </button>
      )}
    </div>
  )
}
