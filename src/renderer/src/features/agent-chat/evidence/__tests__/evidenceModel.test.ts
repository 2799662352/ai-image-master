import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '../../../../../../types/agent-timeline'
import { groupTimelineItemsForChat, getEvidenceSummary, isEvidenceItem } from '../evidenceModel'

const text = (id: string, content = id): TimelineItem => ({ type: 'text', id, startedAt: 1, content })
const reasoning = (id: string): TimelineItem => ({ type: 'reasoning', id, startedAt: 1, content: 'thinking' })
const shell = (id: string): TimelineItem => ({
  type: 'shell',
  id,
  startedAt: 1,
  endedAt: 2,
  command: 'pnpm test',
  stdout: 'ok',
  stderr: '',
  exitCode: 0,
})
const fileEdit = (id: string): TimelineItem => ({
  type: 'fileEdit',
  id,
  startedAt: 1,
  endedAt: 2,
  changes: [{ path: 'src/a.ts', operation: 'edit', diff: '@@\n-old\n+new', added: 1, removed: 1 }],
  totalAdded: 1,
  totalRemoved: 1,
})
const activity = (id: string): TimelineItem => ({
  type: 'activity',
  id,
  startedAt: 1,
  endedAt: 2,
  kind: 'mcpToolCall',
  label: 'mcp:fs/read',
  detail: '{"path":"src/a.ts"}',
  status: 'success',
})
const activityWithKind = (id: string, kind: string): TimelineItem => ({
  ...activity(id),
  kind,
  label: kind,
})
const attachmentRef = {
  id: 'ref',
  kind: 'file' as const,
  name: 'a.txt',
  mime: 'text/plain',
  size: 1,
  uri: 'local-file:/src/a.txt',
}
const artifact = (id: string): TimelineItem => ({
  type: 'artifact',
  id,
  startedAt: 1,
  endedAt: 2,
  artifacts: [attachmentRef],
})
const attachment = (id: string): TimelineItem => ({
  type: 'attachment',
  id,
  startedAt: 1,
  endedAt: 2,
  attachments: [attachmentRef],
})

describe('evidenceModel', () => {
  it('classifies tool-like items as evidence and text/reasoning as narrative', () => {
    expect(isEvidenceItem(shell('cmd'))).toBe(true)
    expect(isEvidenceItem(fileEdit('edit'))).toBe(true)
    expect(isEvidenceItem(activity('act'))).toBe(true)
    expect(isEvidenceItem(artifact('artifact'))).toBe(true)
    expect(isEvidenceItem(attachment('attachment'))).toBe(true)
    expect(isEvidenceItem(text('t'))).toBe(false)
    expect(isEvidenceItem(reasoning('r'))).toBe(false)
  })

  it('groups adjacent evidence and starts a new stack after narrative resumes', () => {
    const groups = groupTimelineItemsForChat([
      text('t1'),
      shell('cmd1'),
      fileEdit('edit1'),
      text('t2'),
      activity('act1'),
    ])

    expect(groups).toEqual([
      { type: 'item', item: text('t1') },
      { type: 'evidence', items: [shell('cmd1'), fileEdit('edit1')] },
      { type: 'item', item: text('t2') },
      { type: 'evidence', items: [activity('act1')] },
    ])
  })

  it('summarizes shell, file edit, and activity evidence without emoji', () => {
    expect(getEvidenceSummary(shell('cmd'))).toMatchObject({
      kind: 'cmd',
      label: 'pnpm test',
      meta: 'success · exit 0',
      status: 'success',
      hasDetails: true,
      hasReference: true,
    })
    expect(getEvidenceSummary(fileEdit('edit'))).toMatchObject({
      kind: 'file',
      label: 'src/a.ts',
      meta: '+1 -1',
      status: 'success',
      hasDetails: true,
    })
    expect(getEvidenceSummary(activity('act'))).toMatchObject({
      kind: 'mcp',
      label: 'mcp:fs/read',
      status: 'success',
      hasDetails: true,
    })
    expect(getEvidenceSummary(activityWithKind('web', 'webSearch'))).toMatchObject({
      kind: 'web',
      label: 'webSearch',
    })
    expect(getEvidenceSummary(activityWithKind('ctx', 'contextCompaction'))).toMatchObject({
      kind: 'ctx',
      label: 'contextCompaction',
    })
    expect(getEvidenceSummary(activityWithKind('unknown', 'unknownTool'))).toMatchObject({
      kind: 'tool',
      label: 'unknownTool',
    })
  })
})
