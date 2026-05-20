// src/renderer/src/components/donor/DonorVirtualGrid.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { Grid, type CellComponentProps } from 'react-window'
import DonorCard from './DonorCard'
import type { DonorItemView } from '../../hooks/useHistoryData'

/**
 * Layout constants — chosen to match DonorCard's current visual footprint
 * (aspect-[4/3] image area + ~150px info area; see DonorCard.tsx).
 *
 * MIN_CARD_WIDTH=220 keeps the existing 4-column layout on >=880px viewports
 * while letting narrow windows fall back to 2-3 columns.
 *
 * VIRTUALIZE_THRESHOLD=30 mirrors BatchResultGrid — small collections keep
 * the page-scroll UX, large ones get inner-scroll viewport.
 */
const MIN_CARD_WIDTH = 220
const CARD_GAP = 16
const CARD_INFO_AREA_PX = 152
const VIRTUALIZE_THRESHOLD = 30
const VIEWPORT_MAX_PX = 720

function useContainerSize() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const computeViewportH = () =>
      Math.max(360, Math.min(VIEWPORT_MAX_PX, Math.floor(window.innerHeight * 0.7)))

    const node = ref.current
    if (!node) return

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setSize({ width: Math.floor(entry.contentRect.width), height: computeViewportH() })
    })
    ro.observe(node)

    const onResize = () => {
      setSize((s) => ({ width: s.width, height: computeViewportH() }))
    }
    window.addEventListener('resize', onResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return { ref, width: size.width, height: size.height }
}

interface Props {
  items: DonorItemView[]
  onDelete: (id: number | string) => void
  onPreview: (item: DonorItemView, index: number) => void
  onEdit?: (item: DonorItemView) => void
}

type CellPropsT = {
  items: DonorItemView[]
  columnCount: number
  onDelete: Props['onDelete']
  onPreview: Props['onPreview']
  onEdit: Props['onEdit']
}

function VirtualCell({
  columnIndex,
  rowIndex,
  style,
  items,
  columnCount,
  onDelete,
  onPreview,
  onEdit,
}: CellComponentProps<CellPropsT>) {
  const idx = rowIndex * columnCount + columnIndex
  const item = items[idx]
  if (!item) return <div style={style} />
  return (
    <div
      style={{
        ...style,
        paddingRight: CARD_GAP,
        paddingBottom: CARD_GAP,
        boxSizing: 'border-box',
      }}
    >
      <DonorCard item={item} onDelete={onDelete} onPreview={onPreview} onEdit={onEdit} />
    </div>
  )
}

export default function DonorVirtualGrid({ items, onDelete, onPreview, onEdit }: Props) {
  const { ref: containerRef, width: containerWidth, height: viewportH } = useContainerSize()

  const gridLayout = useMemo(() => {
    if (containerWidth <= 0) return null
    const columnCount = Math.max(1, Math.floor(containerWidth / MIN_CARD_WIDTH))
    const columnWidth = Math.floor(containerWidth / columnCount)
    const cardVisualWidth = Math.max(0, columnWidth - CARD_GAP)
    // DonorCard image is aspect-[4/3] → image height = width * 3/4
    const imageH = Math.floor(cardVisualWidth * 0.75)
    const rowHeight = imageH + CARD_INFO_AREA_PX + CARD_GAP
    const rowCount = Math.ceil(items.length / columnCount)
    return { columnCount, columnWidth, rowHeight, rowCount }
  }, [containerWidth, items.length])

  const cellProps: CellPropsT | null = useMemo(() => {
    if (!gridLayout) return null
    return {
      items,
      columnCount: gridLayout.columnCount,
      onDelete,
      onPreview,
      onEdit,
    }
  }, [items, gridLayout, onDelete, onPreview, onEdit])

  const shouldVirtualize =
    items.length >= VIRTUALIZE_THRESHOLD && gridLayout !== null && cellProps !== null

  return (
    <div ref={containerRef} className="w-full">
      {shouldVirtualize && gridLayout && cellProps ? (
        <Grid
          cellComponent={VirtualCell}
          cellProps={cellProps}
          columnCount={gridLayout.columnCount}
          columnWidth={gridLayout.columnWidth}
          rowCount={gridLayout.rowCount}
          rowHeight={gridLayout.rowHeight}
          overscanCount={2}
          style={{ height: viewportH, width: '100%' }}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {items.map((it) => (
            <DonorCard
              key={it.id}
              item={it}
              onDelete={onDelete}
              onPreview={onPreview}
              onEdit={onEdit}
            />
          ))}
        </div>
      )}
    </div>
  )
}
