import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { AgentReference } from '../../../../../types/agent-reference'
import type { AttachmentRef, TimelineItem } from '../../../../../types/agent-timeline'
import {
  MediaThumbnail,
  classifyMediaKind,
} from '../../../components/shared/media/MediaThumbnail'
import { toRenderableUri } from '../../file-explorer/uri'
import { useFileExplorerStore } from '../../file-explorer/store'
import { referencesFromTimelineItem } from '../references/referenceUtils'
import { useAgentChatStore } from '../store'
import { EvidenceDetails } from './EvidenceDetails'
import { getEvidenceSummary, mediaRefsOf } from './evidenceModel'

const CLICK_DELAY_MS = 200

type EvidenceStackProps = {
  items: TimelineItem[]
}

export function EvidenceStack({ items }: EvidenceStackProps) {
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null)
  const [panelErrorItemId, setPanelErrorItemId] = useState<string | null>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openReference = useFileExplorerStore((state) => state.openReference)
  const openPreview = useAgentChatStore((state) => state.openPreview)

  // attachment/artifact 上的"点缩略图"复用 AttachmentCard 的"双效":
  //   1) Lightbox 弹出大图(autoPlay video)
  //   2) reveal 到文件展示栏(走 openReference)
  // chip 文本继续保留 —— 是给 Codex CLI / 截图分享读的语义。
  const handleMediaClick = (item: TimelineItem, clicked: AttachmentRef): void => {
    const media = mediaRefsOf(item)
    if (media.length === 0) return
    const previewable = media.map((ref) => ({
      ...ref,
      uri: toRenderableUri(ref.uri),
      thumbnailUri: ref.thumbnailUri ? toRenderableUri(ref.thumbnailUri) : undefined,
    }))
    const startIndex = media.findIndex((m) => m.id === clicked.id)
    if (startIndex >= 0) openPreview(previewable, startIndex)

    // 找到这个 attachment 对应的 reference 并 reveal。AttachmentCard 用 id 后缀
    // 匹配,这里同样的逻辑:reference.id 形如 `attachment:<ref.id>` / `artifact:<ref.id>`。
    const refs = referencesFromTimelineItem(item)
    const target = refs.find((r) => {
      const colon = r.id.indexOf(':')
      return colon > 0 && r.id.slice(colon + 1) === clicked.id
    })
    if (target) void openReference(target).catch(() => setPanelErrorItemId(item.id))
  }

  const clearClickTimer = (): void => {
    if (clickTimer.current == null) return
    clearTimeout(clickTimer.current)
    clickTimer.current = null
  }

  useEffect(() => clearClickTimer, [])

  const openReferenceInPanel = (item: TimelineItem, reference: AgentReference): void => {
    setPanelErrorItemId(null)
    void openReference(reference).catch(() => {
      setPanelErrorItemId(item.id)
      if (getEvidenceSummary(item).hasDetails) {
        setExpandedItemId(item.id)
      }
    })
  }

  const openFirstReference = (item: TimelineItem, reference: AgentReference | null): void => {
    if (!reference) return
    openReferenceInPanel(item, reference)
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
    openFirstReference(item, primaryReferenceForChip(item))
  }

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    item: TimelineItem,
    reference: AgentReference | null,
  ): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      openFirstReference(item, reference)
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
          const reference = primaryReferenceForChip(item)
          const canInteract = summary.hasDetails || reference != null
          const ariaLabel = [summary.kind, summary.label, summary.meta].filter(Boolean).join(' ')
          const chipClassName = [
            'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] leading-none transition-colors',
            statusClass(summary.status, canInteract),
          ].join(' ')
          const chipContent = (
            <>
              <span className="font-semibold tracking-[0.14em] text-zinc-500 uppercase">{summary.kind}</span>
              <span className="max-w-[260px] truncate font-medium">{summary.label}</span>
              {summary.meta ? <span className="text-zinc-500">{summary.meta}</span> : null}
              {summary.hasDetails ? (
                <span className="text-zinc-500" aria-hidden="true">
                  {expanded ? 'Hide' : 'Show'}
                </span>
              ) : null}
            </>
          )

          const mediaRefs = mediaRefsOf(item)
          return (
            <div key={item.id} className="flex max-w-full flex-col gap-1">
              {mediaRefs.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {mediaRefs.map((ref) => {
                    const kind = classifyMediaKind({
                      kind: ref.kind,
                      mime: ref.mime,
                      name: ref.name,
                    })
                    if (!kind) return null
                    return (
                      <MediaThumbnail
                        key={ref.id}
                        src={toRenderableUri(ref.thumbnailUri ?? ref.uri)}
                        kind={kind}
                        name={ref.name}
                        posterSrc={
                          ref.thumbnailUri ? toRenderableUri(ref.thumbnailUri) : undefined
                        }
                        onClick={() => handleMediaClick(item, ref)}
                        className="h-14 w-14"
                      />
                    )
                  })}
                </div>
              ) : null}
              {canInteract ? (
                <button
                  type="button"
                  aria-label={ariaLabel}
                  onClick={() => handleClick(item)}
                  onDoubleClick={() => handleDoubleClick(item)}
                  onKeyDown={(event) => handleKeyDown(event, item, reference)}
                  aria-expanded={summary.hasDetails ? expanded : undefined}
                  className={[
                    chipClassName,
                    'cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 focus-visible:outline-none',
                  ].join(' ')}
                >
                  {chipContent}
                </button>
              ) : (
                <span aria-label={ariaLabel} className={chipClassName}>
                  {chipContent}
                </span>
              )}
              {expanded && summary.hasDetails ? (
                <EvidenceDetails
                  item={item}
                  reference={reference}
                  openError={panelErrorItemId === item.id}
                  onOpenReference={(nextReference) => openReferenceInPanel(item, nextReference)}
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function primaryReferenceForChip(item: TimelineItem): AgentReference | null {
  const summary = getEvidenceSummary(item)
  if (!summary.hasDetails && item.type === 'activity') return null
  return referencesFromTimelineItem(item)[0] ?? null
}

function statusClass(status: ReturnType<typeof getEvidenceSummary>['status'], canInteract: boolean): string {
  const hoverClass = canInteract ? ' hover:border-zinc-500/80' : ''
  switch (status) {
    case 'running':
      return `border-cyan-500/35 bg-cyan-500/10 text-cyan-100${canInteract ? ' hover:border-cyan-400/60' : ''}`
    case 'success':
      return `border-zinc-700/70 bg-zinc-900/75 text-zinc-200${hoverClass}`
    case 'error':
      return `border-red-500/45 bg-red-500/10 text-red-100${canInteract ? ' hover:border-red-400/70' : ''}`
    case 'cancelled':
      return `border-amber-500/35 bg-amber-500/10 text-amber-100${canInteract ? ' hover:border-amber-400/60' : ''}`
  }
}
