import { useErasePersistStore } from '../../stores/useErasePersistStore'
import { useEraseSessionStore } from '../../stores/useEraseSessionStore'
import { EraseResultCard } from './EraseResultCard'

const MAX_GRID_ITEMS = 12

export function EraseResultGrid() {
  const history = useErasePersistStore((s) => s.history)
  const hydrated = useErasePersistStore((s) => s._hasHydrated)
  const recentlyFinished = useEraseSessionStore((s) => s.recentlyFinished)

  if (!hydrated || history.length === 0) return null

  const items = history.slice(0, MAX_GRID_ITEMS)

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {items.map((item) => (
        <EraseResultCard
          key={item.id}
          item={item}
          highlight={item.id === recentlyFinished}
        />
      ))}
    </div>
  )
}
