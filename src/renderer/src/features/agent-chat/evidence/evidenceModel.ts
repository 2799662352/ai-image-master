import type {
  ActivityItem,
  ArtifactItem,
  AttachmentItem,
  AttachmentRef,
  FileEditItem,
  ShellItem,
  TimelineItem,
} from '../../../../../types/agent-timeline'
import { classifyMediaKind } from '../../../components/shared/media/MediaThumbnail'
import { referencesFromTimelineItem } from '../references/referenceUtils'

export type ChatRenderGroup =
  | { type: 'item'; item: TimelineItem }
  | { type: 'evidence'; items: TimelineItem[] }

export type EvidenceStatus = 'running' | 'success' | 'error' | 'cancelled'

export type EvidenceSummary = {
  kind: string
  label: string
  meta: string
  status: EvidenceStatus
  hasDetails: boolean
  hasReference: boolean
}

function assertNever(value: never): never {
  throw new Error(`Unhandled timeline item: ${JSON.stringify(value)}`)
}

export function isEvidenceItem(item: TimelineItem): boolean {
  switch (item.type) {
    case 'shell':
    case 'fileEdit':
    case 'activity':
    case 'artifact':
    case 'attachment':
      return true
    case 'text':
    case 'reasoning':
      return false
    default:
      return assertNever(item)
  }
}

export function groupTimelineItemsForChat(items: TimelineItem[]): ChatRenderGroup[] {
  const groups: ChatRenderGroup[] = []
  let pendingEvidence: TimelineItem[] = []

  const flushEvidence = (): void => {
    if (pendingEvidence.length === 0) return
    groups.push({ type: 'evidence', items: pendingEvidence })
    pendingEvidence = []
  }

  for (const item of items) {
    if (isEvidenceItem(item)) {
      pendingEvidence.push(item)
      continue
    }
    flushEvidence()
    groups.push({ type: 'item', item })
  }
  flushEvidence()
  return groups
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

/**
 * 返回 attachment / artifact item 里"能渲染缩略图的" media refs。
 *
 * 用途:EvidenceStack chip、EvidenceDetails.AttachmentList、MentionInput
 * 都需要在文本旁边补一张缩略图 —— 而不是替换文本(Codex CLI 还要看 chip
 * 的 kind/label 文本来理解上下文)。
 *
 * Filter 规则跟 AttachmentCard.isRenderableMedia 一致:
 *  1) classifyMediaKind 能判出 image / video
 *  2) 至少有一个非空的可显示 URI(优先 thumbnailUri,其次 uri)
 */
export function mediaRefsOf(item: TimelineItem): AttachmentRef[] {
  if (item.type !== 'attachment' && item.type !== 'artifact') return []
  const refs: readonly AttachmentRef[] =
    item.type === 'attachment'
      ? (item as AttachmentItem).attachments
      : (item as ArtifactItem).artifacts
  const kept: AttachmentRef[] = []
  for (const ref of refs) {
    const kind = classifyMediaKind({ kind: ref.kind, mime: ref.mime, name: ref.name })
    const src = ref.thumbnailUri ?? ref.uri
    const hasSrc = typeof src === 'string' && src.length > 0
    if (kind != null && hasSrc) {
      kept.push(ref)
      continue
    }
    // DEV-only diagnostic so when a user reports "thumbnail didn't show up",
    // we can see in the renderer console exactly which gate failed. In prod
    // we stay silent — a no-thumbnail render is a valid outcome for real
    // non-media attachments.
    if (
      typeof import.meta !== 'undefined' &&
      import.meta.env?.DEV &&
      typeof console !== 'undefined'
    ) {
      // eslint-disable-next-line no-console
      console.warn('[mediaRefsOf] skipped attachment', {
        timelineItemId: item.id,
        refId: ref.id,
        name: ref.name,
        kindField: ref.kind,
        mime: ref.mime,
        uri: ref.uri,
        thumbnailUri: ref.thumbnailUri,
        classified: kind,
        hasSrc,
        reason: kind == null ? 'classifyMediaKind=null' : 'empty src',
      })
    }
  }
  return kept
}

function shellStatus(item: ShellItem): EvidenceStatus {
  if (!item.endedAt) return 'running'
  return item.exitCode === 0 ? 'success' : 'error'
}

function fileStatus(item: FileEditItem): EvidenceStatus {
  return item.endedAt ? 'success' : 'running'
}

function activityStatus(item: ActivityItem): EvidenceStatus {
  if (!item.endedAt) return 'running'
  return item.status ?? 'success'
}

function activityKind(kind: string): string {
  if (kind === 'mcpToolCall') return 'mcp'
  if (kind === 'webSearch') return 'web'
  if (kind === 'contextCompaction') return 'ctx'
  return 'tool'
}

export function getEvidenceSummary(item: TimelineItem): EvidenceSummary {
  const references = referencesFromTimelineItem(item)
  const hasReference = references.length > 0

  switch (item.type) {
    case 'shell': {
      const status = shellStatus(item)
      return {
        kind: 'cmd',
        label: item.command || 'command',
        meta: item.exitCode == null ? status : `${status} · exit ${item.exitCode}`,
        status,
        hasDetails: true,
        hasReference,
      }
    }
    case 'fileEdit': {
      const first = item.changes[0]
      const label = item.changes.length === 1 && first ? first.path : `${item.changes.length} files changed`
      return {
        kind: 'file',
        label,
        meta: `+${item.totalAdded} -${item.totalRemoved}`,
        status: fileStatus(item),
        hasDetails: item.changes.length > 0,
        hasReference,
      }
    }
    case 'activity': {
      return {
        kind: activityKind(item.kind),
        label: item.label ?? item.kind,
        meta: activityStatus(item),
        status: activityStatus(item),
        hasDetails: typeof item.detail === 'string' && item.detail.length > 0,
        hasReference,
      }
    }
    case 'artifact': {
      const first = item.artifacts[0]
      return {
        kind: 'file',
        label: first ? basename(first.name) : 'artifact',
        meta: `${item.artifacts.length} artifact${item.artifacts.length === 1 ? '' : 's'}`,
        status: item.endedAt ? 'success' : 'running',
        hasDetails: item.artifacts.length > 0,
        hasReference,
      }
    }
    case 'attachment': {
      const first = item.attachments[0]
      return {
        kind: 'file',
        label: first ? basename(first.name) : 'attachment',
        meta: `${item.attachments.length} attachment${item.attachments.length === 1 ? '' : 's'}`,
        status: item.endedAt ? 'success' : 'running',
        hasDetails: item.attachments.length > 0,
        hasReference,
      }
    }
    case 'text':
    case 'reasoning':
      return {
        kind: 'text',
        label: item.type,
        meta: '',
        status: 'success',
        hasDetails: false,
        hasReference: false,
      }
    default:
      return assertNever(item)
  }
}
