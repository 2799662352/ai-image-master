import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { TimelineItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { referencesFromTimelineItem } from '../references/referenceUtils'
import { EvidenceDetails } from './EvidenceDetails'
import { getEvidenceSummary } from './evidenceModel'

const CLICK_DELAY_MS = 200

type EvidenceStackProps = {
  items: TimelineItem[]
}

export function EvidenceStack({ items }: EvidenceStackProps) {
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openReference = useFileExplorerStore((state) => state.openReference)

  const clearClickTimer = (): void => {
    if (clickTimer.current == null) return
    clearTimeout(clickTimer.current)
    clickTimer.current = null
  }

  const openFirstReference = (item: TimelineItem): void => {
    const reference = referencesFromTimelineItem(item)[0]
    if (!reference) return
    void openReference(reference)
  }

  const toggleDetails = (item: TimelineItem): void => {
    if (!getEvidenceSummary(item).hasDetails) return
    setExpandedItemId((current) => (current === item.id ? null : item.id))
  }

  const handleClick = (item: TimelineItem): void => {
    clearClickTimer()
    clickTimer.current = setTimeout(() => {
      toggleDetails(item)
      clickTimer.current = null
    }, CLICK_DELAY_MS)
  }

  const handleDoubleClick = (item: TimelineItem): void => {
    clearClickTimer()
    setExpandedItemId(null)
    openFirstReference(item)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, item: TimelineItem): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      openFirstReference(item)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleDetails(item)
    }
  }

  return (
    <div className="my-1 flex flex-col gap-1">
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => {
          const summary = getEvidenceSummary(item)
          const expanded = expandedItemId === item.id
          const reference = referencesFromTimelineItem(item)[0] ?? null
          const ariaLabel = [summary.kind, summary.label, summary.meta].filter(Boolean).join(' ')

          return (
            <div key={item.id} className="max-w-full">
              <button
                type="button"
                aria-label={ariaLabel}
                onClick={() => handleClick(item)}
                onDoubleClick={() => handleDoubleClick(item)}
                onKeyDown={(event) => handleKeyDown(event, item)}
                aria-expanded={summary.hasDetails ? expanded : undefined}
                className={[
                  'inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] leading-none transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 focus-visible:outline-none',
                  statusClass(summary.status),
                ].join(' ')}
              >
                <span className="font-semibold tracking-[0.14em] text-zinc-500 uppercase">{summary.kind}</span>
                <span className="max-w-[260px] truncate font-medium">{summary.label}</span>
                {summary.meta ? <span className="text-zinc-500">{summary.meta}</span> : null}
                {summary.hasDetails ? (
                  <span className="text-zinc-500" aria-hidden="true">
                    {expanded ? 'Hide' : 'Show'}
                  </span>
                ) : null}
              </button>
              {expanded && summary.hasDetails ? (
                <EvidenceDetails
                  item={item}
                  reference={reference}
                  onOpenReference={(nextReference) => void openReference(nextReference)}
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function statusClass(status: ReturnType<typeof getEvidenceSummary>['status']): string {
  switch (status) {
    case 'running':
      return 'border-cyan-500/35 bg-cyan-500/10 text-cyan-100 hover:border-cyan-400/60'
    case 'success':
      return 'border-zinc-700/70 bg-zinc-900/75 text-zinc-200 hover:border-zinc-500/80'
    case 'error':
      return 'border-red-500/45 bg-red-500/10 text-red-100 hover:border-red-400/70'
    case 'cancelled':
      return 'border-amber-500/35 bg-amber-500/10 text-amber-100 hover:border-amber-400/60'
  }
}
