import type { SplitHistoryItem } from '../../../../types/storyboardSplit'
import SplitResultCard from './SplitResultCard'

const GRID_COLS_CLASS: Record<2 | 3 | 4 | 6, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  6: 'grid-cols-6',
}

interface Props {
  items: SplitHistoryItem[]
  gridCols: 2 | 3 | 4 | 6
  highlightId: string | null
  onPreview: (id: string) => void
  onDelete: (id: string) => void
}

export default function ResultsGrid({ items, gridCols, highlightId, onPreview, onDelete }: Props) {
  if (items.length === 0) return null

  return (
    <div className={`grid ${GRID_COLS_CLASS[gridCols]} gap-4`}>
      {items.map((item) => (
        <SplitResultCard
          key={item.id}
          item={item}
          isHighlighted={item.id === highlightId}
          onPreview={onPreview}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
