import { useEffect, useMemo } from 'react'
import { useToastStore, useHistoryStore } from '../stores'
import { useHistory } from '../hooks/useHistory'

export default function HistoryPage() {
  const history = useHistory()
  const addToast = useToastStore((s) => s.addToast)

  const items = useHistoryStore((s) => s.items)
  const searchQuery = useHistoryStore((s) => s.searchQuery)
  const error = useHistoryStore((s) => s.error)

  const { setSearchQuery, loadHistory, deleteItem } = useHistoryStore.getState()

  useEffect(() => {
    loadHistory(history)
  }, [])

  useEffect(() => {
    if (error) addToast({ message: error, type: 'error' })
  }, [error])

  const filtered = useMemo(() => {
    if (!searchQuery) return items
    const q = searchQuery.toLowerCase()
    return items.filter((i) => i.prompt.toLowerCase().includes(q))
  }, [items, searchQuery])

  const handleDelete = (id: number) => {
    deleteItem(id, history)
    if (!useHistoryStore.getState().error) {
      addToast({ message: '已删除', type: 'success' })
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">📜 生成历史</h1>
        <span className="text-sm text-zinc-500">{items.length} 条记录</span>
      </div>

      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="搜索提示词..."
        className="w-full px-4 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
      />

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-zinc-600">暂无历史记录</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((item) => (
            <div
              key={item.id}
              className="bg-zinc-900 border-2 border-zinc-700 p-4 space-y-3 hover:border-zinc-500 transition-colors"
            >
              {item.urls?.[0] && (
                <img
                  src={item.urls[0]}
                  alt={item.prompt}
                  className="w-full h-40 object-cover bg-zinc-800"
                  loading="lazy"
                />
              )}
              <p className="text-sm text-gray-300 line-clamp-2">{item.prompt}</p>
              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span>{item.model ?? '未知模型'}</span>
                <span>{new Date(item.timestamp).toLocaleDateString()}</span>
              </div>
              <button
                onClick={() => handleDelete(item.id)}
                className="text-xs text-red-400 hover:text-red-300"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
