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
    case 'attachment':
      return true
    case 'artifact':
      // Codex in-app image generations carry a `status` and render inline as a
      // prominent card (spinner → thumbnail → error) instead of a collapsed
      // evidence chip. Plain artifacts (no status) stay in the evidence stack.
      return item.status == null
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
/**
 * DEV diagnostic dedup: mediaRefsOf runs inside the React render path, so
 * without this every re-render of a bubble re-warns about the same ref and
 * floods the console (observed: dozens of identical lines per .txt chip).
 */
const warnedSkippedRefs = new Set<string>()

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
    // kind == null means a genuinely non-media attachment (.txt, .pdf, …) —
    // rendering it as a plain file chip without a thumbnail is the CORRECT
    // outcome, not a failure. Stay silent.
    if (kind == null) continue
    // DEV-only diagnostic for the genuinely suspicious case: the ref claims
    // to be image/video but carries no displayable URI, so a thumbnail the
    // user expects will be missing. Warn once per ref; prod stays silent.
    if (
      typeof import.meta !== 'undefined' &&
      import.meta.env?.DEV &&
      typeof console !== 'undefined' &&
      !warnedSkippedRefs.has(ref.id)
    ) {
      warnedSkippedRefs.add(ref.id)
      // eslint-disable-next-line no-console
      console.warn('[mediaRefsOf] media attachment has no displayable src', {
        timelineItemId: item.id,
        refId: ref.id,
        name: ref.name,
        kindField: ref.kind,
        mime: ref.mime,
        uri: ref.uri,
        thumbnailUri: ref.thumbnailUri,
        classified: kind,
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
