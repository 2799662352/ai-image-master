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

/**
 * Extract an OS path from any "local-file-ish" URI shape the renderer may
 * see for an attachment. Returns `''` for things that aren't local files
 * (blob:, http(s):, data:, etc.) — caller treats `''` as "no reference".
 *
 * Accepts three shapes — must keep this in sync with
 * `components/shared/media/useResolvedMediaSrc.ts::toOsPathIfLocal`:
 *
 *   1. `local-file:///D%3A/foo/bar.png` — canonical form produced by
 *      `toRenderableUri`. Strip prefix, percent-decode, drop traversal.
 *
 *   2. `D:\foo\bar.png` or `D:/foo/bar.png` — raw Windows path. This is
 *      what `buildAttachmentUri` returns in the **optimistic** send path
 *      when the renderer only has a file path (no Blob buffer). Without
 *      this branch the just-sent attachment chip would have no reference
 *      attached, so AttachmentCard's click handler can't call
 *      `openReference`, so the file viewer tab never opens (the user
 *      reports it as "needs refresh to display" because reloading the
 *      thread re-fetches messages from main with canonical `local-file://`
 *      URIs that DO pass the prefix check).
 *
 *   3. `/home/user/foo.png` — raw POSIX absolute path. Same scenario on
 *      macOS/Linux.
 *
 * **Do NOT use `new URL()` here.** Chromium parses `local-file` as a
 * standard scheme and applies `file://`-style Windows drive folding:
 * `new URL('local-file:///C%3A/Users/...').pathname` returns
 * `/Users/...` (drive letter silently dropped). Pure string parsing
 * matches `vscode-uri`'s approach. See electron/electron#49073 and
 * microsoft/vscode#209453.
 */
function localPathFromUri(uri: string): string {
  if (typeof uri !== 'string' || uri.length === 0) return ''
  // `local-file:///` form.
  const prefix = 'local-file:///'
  if (uri.toLowerCase().startsWith(prefix)) {
    let decoded: string
    try {
      decoded = decodeURIComponent(uri.slice(prefix.length))
    } catch {
      return ''
    }
    if (decoded.split(/[\\/]/).some((segment) => segment === '..')) return ''
    // Windows path emerges as `C:/Users/...` after decoding `C%3A`.
    if (/^[A-Za-z]:[\\/]/.test(decoded)) return decoded
    // POSIX path lost its leading slash when toRenderableUri prefixed with
    // `local-file:///`; add it back.
    if (!decoded.startsWith('/')) return '/' + decoded
    return decoded
  }
  // Non-local schemes — caller decides what to do.
  if (/^(blob|data|https?|file):/i.test(uri)) return ''
  if (uri.split(/[\\/]/).some((segment) => segment === '..')) return ''
  // Raw Windows path (`C:\foo` or `C:/foo`).
  if (/^[A-Za-z]:[\\/]/.test(uri)) return uri
  // Raw POSIX absolute path.
  if (uri.startsWith('/') && !uri.startsWith('//')) return uri
  return ''
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
    case 'choiceRequest':
      return []
  }
}

export function primaryReferenceFromTimelineItem(item: TimelineItem): AgentReference | null {
  return referencesFromTimelineItem(item)[0] ?? null
}
