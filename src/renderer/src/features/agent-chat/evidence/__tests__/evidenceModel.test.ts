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
    expect(isEvidenceItem(activity('act'))).toBe(true)
    expect(isEvidenceItem(artifact('artifact'))).toBe(true)
    expect(isEvidenceItem(attachment('attachment'))).toBe(true)
    expect(isEvidenceItem(text('t'))).toBe(false)
    expect(isEvidenceItem(reasoning('r'))).toBe(false)
  })

  // 回归:fileEdit 曾和 shell/activity 并列无条件折叠成灰药丸,于是
  // `TimelineItemRenderer` 里那条 fileEdit → FileEditCard 分支永远到不了,
  // 连带 openAiChange(并排 diff 的唯一入口)在全仓变成零调用方。
  it('改文件不是普通证据 —— 带改动的 fileEdit 渲染成独立卡片', () => {
    expect(isEvidenceItem(fileEdit('edit'))).toBe(false)
  })

  it('空改动的 fileEdit 没什么可看的,仍留在证据堆里', () => {
    const empty: TimelineItem = { ...fileEdit('empty'), changes: [], totalAdded: 0, totalRemoved: 0 }
    expect(isEvidenceItem(empty)).toBe(true)
  })

  it('groups adjacent evidence and starts a new stack after narrative resumes', () => {
    const groups = groupTimelineItemsForChat([
      text('t1'),
      shell('cmd1'),
      fileEdit('edit1'),
      text('t2'),
      activity('act1'),
    ])

    const groupSummaries = groups.map((group) =>
      group.type === 'item'
        ? { type: group.type, item: { id: group.item.id, itemType: group.item.type } }
        : {
            type: group.type,
            items: group.items.map((item) => ({ id: item.id, itemType: item.type })),
          },
    )

    expect(groupSummaries).toEqual([
      { type: 'item', item: { id: 't1', itemType: 'text' } },
      { type: 'evidence', items: [{ id: 'cmd1', itemType: 'shell' }] },
      // fileEdit 自己成一组,把前后的证据堆断开 —— 这正是想要的:改文件是
      // 时间线上的一个事件,不该被埋进一排药丸里。
      { type: 'item', item: { id: 'edit1', itemType: 'fileEdit' } },
      { type: 'item', item: { id: 't2', itemType: 'text' } },
      { type: 'evidence', items: [{ id: 'act1', itemType: 'activity' }] },
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
