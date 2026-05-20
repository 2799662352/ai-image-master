import { describe, expect, it } from 'vitest'
import type {
  ActivityItem,
  AttachmentItem,
  ArtifactItem,
  FileEditItem,
  ShellItem,
} from '../../../../../../types/agent-timeline'
import {
  makeFileReference,
  makeUrlReference,
  referencesFromTimelineItem,
} from '../referenceUtils'

describe('makeFileReference', () => {
  it('routes .ts files to the code preview behavior', () => {
    const ref = makeFileReference({ path: 'D:/repo/src/main.ts' })
    expect(ref.type).toBe('file')
    expect(ref.label).toBe('main.ts')
    expect(ref.source).toEqual({ kind: 'localPath', path: 'D:/repo/src/main.ts' })
    expect(ref.openBehavior).toBe('code')
  })

  it('routes .md files to markdown', () => {
    const ref = makeFileReference({ path: 'D:/repo/README.md' })
    expect(ref.openBehavior).toBe('markdown')
  })

  it('routes images by mime', () => {
    const ref = makeFileReference({ path: 'D:/repo/logo.png', mime: 'image/png' })
    expect(ref.openBehavior).toBe('image')
  })

  it('routes PDFs by extension', () => {
    const ref = makeFileReference({ path: 'D:/repo/spec.pdf' })
    expect(ref.openBehavior).toBe('pdf')
  })
})

describe('makeUrlReference', () => {
  it('marks non-http(s) URLs as error so the chip and preview both block', () => {
    const ref = makeUrlReference('javascript:alert(1)')
    expect(ref.openBehavior).toBe('url')
    expect(ref.status).toBe('error')
  })

  it('extracts host and path for https', () => {
    const ref = makeUrlReference('https://developers.openai.com/codex/mcp')
    expect(ref.type).toBe('url')
    expect(ref.label).toBe('developers.openai.com/codex/mcp')
    expect(ref.openBehavior).toBe('url')
    expect(ref.source).toEqual({ kind: 'url', url: 'https://developers.openai.com/codex/mcp' })
  })
})

describe('referencesFromTimelineItem', () => {
  it('returns a single shell reference with execution metadata', () => {
    const item: ShellItem = {
      type: 'shell',
      id: 'cmd_1',
      startedAt: 1,
      endedAt: 2,
      command: 'npm run test',
      cwd: 'D:/repo',
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }
    const refs = referencesFromTimelineItem(item)
    expect(refs).toHaveLength(1)
    const [ref] = refs
    expect(ref.type).toBe('command')
    expect(ref.label).toBe('npm run test')
    expect(ref.openBehavior).toBe('shellOutput')
    expect(ref.status).toBe('success')
  })

  it('marks shell items with missing exit code as error rather than ready', () => {
    const item: ShellItem = {
      type: 'shell',
      id: 'cmd_2',
      startedAt: 1,
      endedAt: 2,
      command: 'npm run test',
      stdout: '',
      stderr: '',
    }
    const [ref] = referencesFromTimelineItem(item)
    expect(ref.status).toBe('error')
  })

  it('maps activity cancelled to stale, not raw cancelled', () => {
    const item: ActivityItem = {
      type: 'activity',
      id: 'mcp_1',
      startedAt: 1,
      endedAt: 2,
      kind: 'mcpToolCall',
      label: 'mcp:github/get_file_contents',
      detail: '{"owner":"openai"}',
      status: 'cancelled',
    }
    const [ref] = referencesFromTimelineItem(item)
    expect(ref.type).toBe('mcp')
    expect(ref.status).toBe('stale')
    expect(ref.openBehavior).toBe('jsonResource')
  })

  it('emits a real URL reference for webSearch (not a JSON resource)', () => {
    const item: ActivityItem = {
      type: 'activity',
      id: 'ws_1',
      startedAt: 1,
      endedAt: 2,
      kind: 'webSearch',
      label: 'Codex MCP docs',
      detail: 'https://developers.openai.com/codex/mcp',
      status: 'success',
    }
    const [ref] = referencesFromTimelineItem(item)
    expect(ref.type).toBe('url')
    expect(ref.openBehavior).toBe('url')
    expect(ref.source).toEqual({ kind: 'url', url: 'https://developers.openai.com/codex/mcp' })
  })

  it('emits one reference per attachment (not just the first)', () => {
    const item: AttachmentItem = {
      type: 'attachment',
      id: 'att_1',
      startedAt: 1,
      attachments: [
        { id: 'a1', kind: 'file', name: 'one.ts', mime: 'text/typescript', size: 1, uri: 'local-file:///D:/r/one.ts' },
        { id: 'a2', kind: 'image', name: 'two.png', mime: 'image/png', size: 1, uri: 'local-file:///D:/r/two.png' },
      ],
    }
    const refs = referencesFromTimelineItem(item)
    expect(refs).toHaveLength(2)
    expect(refs[0].label).toBe('one.ts')
    expect(refs[1].openBehavior).toBe('image')
  })

  it('decodes local-file URIs cross-platform (Windows + POSIX)', () => {
    const winItem: AttachmentItem = {
      type: 'attachment', id: 'att_w', startedAt: 1,
      attachments: [
        { id: 'w1', kind: 'file', name: 'one.ts', mime: 'text/typescript', size: 1, uri: 'local-file:///D:/r/one.ts' },
      ],
    }
    const [winRef] = referencesFromTimelineItem(winItem)
    expect(winRef.source).toEqual({ kind: 'localPath', path: 'D:/r/one.ts' })

    const posixItem: AttachmentItem = {
      type: 'attachment', id: 'att_p', startedAt: 1,
      attachments: [
        { id: 'p1', kind: 'file', name: 'b.ts', mime: 'text/typescript', size: 1, uri: 'local-file:////Users/me/b.ts' },
      ],
    }
    const [posixRef] = referencesFromTimelineItem(posixItem)
    expect(posixRef.source).toEqual({ kind: 'localPath', path: '/Users/me/b.ts' })

    const encodedItem: AttachmentItem = {
      type: 'attachment', id: 'att_e', startedAt: 1,
      attachments: [
        { id: 'e1', kind: 'file', name: 'with space.ts', mime: 'text/typescript', size: 1, uri: 'local-file:///D:/r/with%20space.ts' },
      ],
    }
    const [encodedRef] = referencesFromTimelineItem(encodedItem)
    expect(encodedRef.source).toEqual({ kind: 'localPath', path: 'D:/r/with space.ts' })
  })

  it('namespaces artifact references separately from attachments', () => {
    const item: ArtifactItem = {
      type: 'artifact',
      id: 'art_1',
      startedAt: 1,
      artifacts: [
        { id: 'shared', kind: 'file', name: 'one.ts', mime: 'text/typescript', size: 1, uri: 'local-file:///D:/r/one.ts' },
      ],
    }
    const [ref] = referencesFromTimelineItem(item)
    expect(ref.id.startsWith('artifact:')).toBe(true)
  })

  it('accepts raw OS paths in attachment URIs (optimistic-send window)', () => {
    // During the optimistic-send window the renderer pushes the user message
    // BEFORE main's attachment ingest finishes, so AttachmentRef.uri still
    // carries the raw filesystem path the user picked the file from instead
    // of a canonical `local-file:///` URI. Without raw-path support here the
    // attachment chip becomes un-clickable for ~50ms after send — which the
    // user reported as "needs refresh to display" because reloading the
    // thread re-reads canonical URIs from the persisted message.
    const winItem: AttachmentItem = {
      type: 'attachment', id: 'opt_w', startedAt: 1,
      attachments: [
        { id: 'rw', kind: 'image', name: 'pic.png', mime: 'image/png', size: 1, uri: 'D:\\360MoveData\\Users\\27996\\Documents\\pic.png' },
      ],
    }
    const [winRef] = referencesFromTimelineItem(winItem)
    expect(winRef.source).toEqual({ kind: 'localPath', path: 'D:\\360MoveData\\Users\\27996\\Documents\\pic.png' })

    const posixItem: AttachmentItem = {
      type: 'attachment', id: 'opt_p', startedAt: 1,
      attachments: [
        { id: 'rp', kind: 'image', name: 'pic.png', mime: 'image/png', size: 1, uri: '/Users/me/Pictures/pic.png' },
      ],
    }
    const [posixRef] = referencesFromTimelineItem(posixItem)
    expect(posixRef.source).toEqual({ kind: 'localPath', path: '/Users/me/Pictures/pic.png' })
  })

  it('drops attachment references with blob: / data: / UNC-style URIs', () => {
    // Blob and data URIs can't be expressed as filesystem paths, and
    // `//host/share` would look like a UNC mount we don't want to silently
    // hand to fs.realpath. Each of these should produce NO reference so the
    // AttachmentCard renders an un-openable chip rather than a click target
    // that mysteriously does nothing.
    const item: AttachmentItem = {
      type: 'attachment', id: 'drop_1', startedAt: 1,
      attachments: [
        { id: 'b', kind: 'image', name: 'b.png', mime: 'image/png', size: 1, uri: 'blob:http://localhost/abc' },
        { id: 'd', kind: 'image', name: 'd.png', mime: 'image/png', size: 1, uri: 'data:image/png;base64,iVBORw0' },
        { id: 'u', kind: 'image', name: 'u.png', mime: 'image/png', size: 1, uri: '//share/host/u.png' },
      ],
    }
    const refs = referencesFromTimelineItem(item)
    expect(refs).toHaveLength(0)
  })

  it('drops attachment references with traversal in their URI', () => {
    const traversalItem: AttachmentItem = {
      type: 'attachment',
      id: 'evil_1',
      startedAt: 1,
      attachments: [
        { id: 'safe', kind: 'file', name: 'one.ts', mime: 'text/typescript', size: 1, uri: 'local-file:///D:/r/one.ts' },
        { id: 'traversal', kind: 'file', name: 'evil.txt', mime: 'text/plain', size: 1, uri: 'local-file:///D:/r/../../etc/passwd' },
        { id: 'encoded', kind: 'file', name: 'enc.txt', mime: 'text/plain', size: 1, uri: 'local-file:///D:/r/%2e%2e/etc/passwd' },
        { id: 'wrong-scheme', kind: 'file', name: 'h.html', mime: 'text/html', size: 1, uri: 'https://evil.example.com/x' },
      ],
    }
    const refs = referencesFromTimelineItem(traversalItem)
    expect(refs).toHaveLength(1)
    expect(refs[0].label).toBe('one.ts')
    expect(refs[0].source).toEqual({ kind: 'localPath', path: 'D:/r/one.ts' })
  })

  it('returns a diff reference for file edits', () => {
    const item: FileEditItem = {
      type: 'fileEdit',
      id: 'edit_1',
      startedAt: 1,
      endedAt: 2,
      changes: [{ path: 'a.ts', operation: 'edit', diff: '', added: 1, removed: 1 }],
      totalAdded: 1,
      totalRemoved: 1,
    }
    const [ref] = referencesFromTimelineItem(item)
    expect(ref.type).toBe('artifact')
    expect(ref.openBehavior).toBe('diff')
  })

  it('returns an empty list for text/reasoning items', () => {
    expect(referencesFromTimelineItem({
      type: 'text', id: 't_1', startedAt: 1, content: 'hi',
    })).toEqual([])
    expect(referencesFromTimelineItem({
      type: 'reasoning', id: 'r_1', startedAt: 1, content: 'hi',
    })).toEqual([])
  })
})
