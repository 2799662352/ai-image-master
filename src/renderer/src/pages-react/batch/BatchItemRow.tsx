import type { BatchItem } from '../../stores/useBatchStore'

interface BatchItemRowProps {
  item: BatchItem
  onRemove: (id: string) => void
}

export function BatchItemRow({ item, onRemove }: BatchItemRowProps) {
  const borderClass =
    item.status === 'done' ? 'border-green-700 bg-green-900/10'
    : item.status === 'error' ? 'border-red-700 bg-red-900/10'
    : item.status === 'generating' ? 'border-cyberpunk-yellow/50 bg-cyberpunk-yellow/5'
    : 'border-zinc-700 bg-zinc-900'

  return (
    <div className={`flex items-center gap-3 p-3 border-2 ${borderClass}`}>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-300 truncate">{item.prompt}</p>
        {item.error && <p className="text-xs text-red-400 mt-1">{item.error}</p>}
      </div>
      {(item.resultUrl || item.cosUrl) && (
        <img
          src={item.resultUrl ?? item.cosUrl}
          alt=""
          className="w-10 h-10 object-cover border border-zinc-700"
        />
      )}
      {item.status === 'generating' && (
        <div className="w-4 h-4 border-2 border-cyberpunk-yellow border-t-transparent rounded-full animate-spin" />
      )}
      <button onClick={() => onRemove(item.id)} className="text-zinc-600 hover:text-red-400 text-sm">
        ×
      </button>
    </div>
  )
}
