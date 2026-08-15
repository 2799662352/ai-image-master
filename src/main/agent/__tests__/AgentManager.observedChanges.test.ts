// 盯合成事件的形状:它必须能被 applyAssistantEvent 原样消费,否则落库的
// items 里会多出一条畸形项,而渲染端用的是同一个 reducer。
import { describe, expect, it } from 'vitest'
import { applyAssistantEvent } from '../AgentManager'
import type { AgentStreamEvent } from '../../../types/agent'
import type { FileChange } from '../../../types/agent-timeline'

const observed: FileChange = {
  path: 'D:/w/a.md',
  operation: 'edit',
  diff: '@@ -1 +1 @@\n-a\n+b',
  added: 1,
  removed: 1,
  source: 'observed',
}

describe('observed 改动的合成事件', () => {
  it('applyAssistantEvent 能把它变成一条带 changes 的 fileEdit item', () => {
    const event: AgentStreamEvent = {
      type: 'item_completed',
      threadId: 't1',
      itemId: 'observed-1',
      itemType: 'fileEdit',
      final: { changes: [observed], totalAdded: 1, totalRemoved: 1 },
    }

    const items = applyAssistantEvent([], event)

    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('fileEdit')
    expect(items[0]).toMatchObject({ changes: [observed], totalAdded: 1, totalRemoved: 1 })
  })
})
