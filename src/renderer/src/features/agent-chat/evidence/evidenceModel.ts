import type {
  ActivityItem,
  FileEditItem,
  ShellItem,
  TimelineItem,
} from '../../../../../types/agent-timeline'
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

export function isEvidenceItem(item: TimelineItem): boolean {
  return (
    item.type === 'shell' ||
    item.type === 'fileEdit' ||
    item.type === 'activity' ||
    item.type === 'artifact' ||
    item.type === 'attachment'
  )
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
  }
}
