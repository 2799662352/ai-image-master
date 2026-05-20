import type {
  AgentReference,
  AgentReferenceOpenBehavior,
  AgentReferenceStatus,
  AgentReferenceType,
} from '../../../../../types/agent-reference'
import type {
  ActivityItem,
  ArtifactItem,
  AttachmentItem,
  AttachmentRef,
  FileEditItem,
  ShellItem,
  TimelineItem,
} from '../../../../../types/agent-timeline'

const URL_REGEX = /https?:\/\/[^\s]+/i

function createReferenceId(prefix: string, value: string): string {
  return `${prefix}:${value}`
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

function labelForUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '')
  } catch {
    return url
  }
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'])

function openBehaviorForFile(name: string, mime?: string): AgentReferenceOpenBehavior {
  const lower = name.toLowerCase()
  if (mime?.startsWith('image/')) return 'image'
  if (mime?.startsWith('video/')) return 'video'
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown'
  const ext = lower.slice(lower.lastIndexOf('.'))
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'code'
}

function localPathFromUri(uri: string): string {
  try {
    if (!uri.toLowerCase().startsWith('local-file:')) return ''
    const decodedRawPath = decodeURIComponent(uri.slice('local-file:'.length))
    if (decodedRawPath.split(/[\\/]/).some((segment) => segment === '..')) return ''

    const url = new URL(uri)
    if (url.protocol !== 'local-file:') return ''

    const decoded = decodeURIComponent(url.pathname)
    if (decoded.split(/[\\/]/).some((segment) => segment === '..')) return ''

    const stripped = decoded
      .replace(/^\/(?=[A-Za-z]:)/, '')
      .replace(/^\/{2,}(?=[^/])/, '/')
    const isAbsolute = stripped.startsWith('/') || /^[A-Za-z]:[\\/]/.test(stripped)
    return isAbsolute ? stripped : ''
  } catch {
    return ''
  }
}

export function makeFileReference(input: {
  path: string
  name?: string
  mime?: string
}): AgentReference {
  const name = input.name ?? basename(input.path)
  return {
    id: createReferenceId('file', input.path),
    type: 'file',
    label: name,
    source: { kind: 'localPath', path: input.path },
    status: 'ready',
    openBehavior: openBehaviorForFile(name, input.mime),
    preview: { mime: input.mime },
  }
}

export function makeUrlReference(url: string): AgentReference {
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }

  const isSafe = parsed != null && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
  return {
    id: createReferenceId('url', url),
    type: 'url',
    label: isSafe ? labelForUrl(url) : url,
    source: { kind: 'url', url },
    status: isSafe ? 'ready' : 'error',
    openBehavior: 'url',
  }
}

function shellStatus(item: ShellItem): AgentReferenceStatus {
  if (!item.endedAt) return 'running'
  if (item.exitCode == null) return 'error'
  return item.exitCode === 0 ? 'success' : 'error'
}

function referenceFromShellItem(item: ShellItem): AgentReference {
  return {
    id: createReferenceId('command', item.id),
    type: 'command',
    label: item.command || 'command',
    source: { kind: 'codexItem', itemId: item.id },
    status: shellStatus(item),
    openBehavior: 'shellOutput',
    preview: {
      command: item.command,
      cwd: item.cwd,
      stdout: item.stdout,
      stderr: item.stderr,
      exitCode: item.exitCode,
    },
  }
}

function activityStatus(input: ActivityItem['status'], hasEnded: boolean): AgentReferenceStatus {
  switch (input) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'running':
      return 'running'
    case 'cancelled':
      return 'stale'
    case undefined:
      return hasEnded ? 'success' : 'running'
  }
}

function extractFirstUrl(...sources: Array<string | undefined>): string | null {
  for (const source of sources) {
    if (!source) continue
    const match = source.match(URL_REGEX)
    if (match) return match[0]
  }
  return null
}

function activityType(kind: string): AgentReferenceType {
  if (kind === 'mcpToolCall') return 'mcp'
  if (kind === 'webSearch') return 'url'
  return 'activity'
}

function referenceFromActivityItem(item: ActivityItem): AgentReference {
  const type = activityType(item.kind)

  if (type === 'url') {
    const url = extractFirstUrl(item.detail, item.label)
    if (url) {
      return {
        id: createReferenceId('url', url),
        type: 'url',
        label: item.label ?? labelForUrl(url),
        source: { kind: 'url', url },
        status: activityStatus(item.status, item.endedAt != null),
        openBehavior: 'url',
        preview: { summary: item.detail },
      }
    }
  }

  const safeType: AgentReferenceType = type === 'url' ? 'activity' : type
  return {
    id: createReferenceId(safeType, item.id),
    type: safeType,
    label: item.label ?? item.kind,
    source: { kind: 'codexItem', itemId: item.id },
    status: activityStatus(item.status, item.endedAt != null),
    openBehavior: 'jsonResource',
    preview: {
      summary: item.detail,
      json: { kind: item.kind, label: item.label, detail: item.detail, status: item.status },
    },
  }
}

function referenceFromFileEditItem(item: FileEditItem): AgentReference {
  return {
    id: createReferenceId('fileEdit', item.id),
    type: 'artifact',
    label: `${item.changes.length} file change${item.changes.length === 1 ? '' : 's'}`,
    source: { kind: 'codexItem', itemId: item.id },
    status: item.endedAt ? 'success' : 'running',
    openBehavior: 'diff',
    preview: { json: item.changes },
  }
}

function referenceFromAttachmentRef(prefix: 'attachment' | 'artifact', ref: AttachmentRef): AgentReference | null {
  const localPath = localPathFromUri(ref.uri)
  if (!localPath) return null

  const type: AgentReference['type'] =
    ref.kind === 'image' ? 'image' : ref.kind === 'video' ? 'video' : 'file'

  return {
    id: createReferenceId(prefix, ref.id),
    type,
    label: ref.name,
    source: { kind: 'localPath', path: localPath },
    status: 'ready',
    openBehavior: openBehaviorForFile(ref.name, ref.mime),
    preview: { mime: ref.mime, thumbnailUri: ref.thumbnailUri },
  }
}

function nonNull<T>(value: T | null): value is T {
  return value !== null
}

export function referencesFromTimelineItem(item: TimelineItem): AgentReference[] {
  switch (item.type) {
    case 'shell':
      return [referenceFromShellItem(item)]
    case 'activity':
      return [referenceFromActivityItem(item)]
    case 'fileEdit':
      return [referenceFromFileEditItem(item)]
    case 'attachment':
      return item.attachments
        .map((ref) => referenceFromAttachmentRef('attachment', ref))
        .filter(nonNull)
    case 'artifact':
      return item.artifacts
        .map((ref) => referenceFromAttachmentRef('artifact', ref))
        .filter(nonNull)
    case 'text':
    case 'reasoning':
      return []
  }
}

export function primaryReferenceFromTimelineItem(item: TimelineItem): AgentReference | null {
  return referencesFromTimelineItem(item)[0] ?? null
}
