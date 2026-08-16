import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentStreamEvent } from '../../../../../types/agent'
import type { FileEditItem } from '../../../../../types/agent-timeline'
import { useAgentChatStore } from '../store'

function applyEvent(event: AgentStreamEvent): void {
  useAgentChatStore.getState().applyEvent(event)
}

function currentFileEdit(): FileEditItem {
  const { messages } = useAgentChatStore.getState()
  for (let i = messages.length - 1; i >= 0; i--) {
    const found = messages[i].items.find((it): it is FileEditItem => it.type === 'fileEdit')
    if (found) return found
  }
  throw new Error('no fileEdit item in timeline')
}

function started(payload: Record<string, unknown>): void {
  applyEvent({
    type: 'item_started',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'fc-1',
    itemType: 'fileEdit',
    payload,
  })
}

function delta(text: string): void {
  applyEvent({
    type: 'item_delta',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'fc-1',
    itemType: 'fileEdit',
    patch: { kind: 'appendText', field: 'diff', text },
  })
}

/**
 * 渲染层对 `appendText / field: 'diff'` 的消费。协议侧已经在发增量了,这里
 * 锁住它落到哪儿:追加到 changes[0].diff,并且顺带把 +N/−N 重算 —— 否则卡片
 * 头上一路挂着 +0 −0,直到 completed 才跳成真值。
 */
describe('fileEdit 增量 diff 落库', () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: [],
      isRunning: false,
      error: undefined,
      tokenUsage: undefined,
      pendingApprovals: [],
      threadSlices: {},
      runningByThread: {},
    })
  })

  it('item_started 带 path 时先建一个空 diff 的占位改动', () => {
    started({ path: 'src/a.ts' })

    expect(currentFileEdit().changes).toEqual([
      { path: 'src/a.ts', operation: 'edit', diff: '', added: 0, removed: 0 },
    ])
  })

  it('增量逐段追加,+N/−N 跟着涨', () => {
    started({ path: 'src/a.ts' })

    delta('@@ -1 +1 @@\n-old\n')
    expect(currentFileEdit()).toMatchObject({
      changes: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n', added: 0, removed: 1 }],
      totalAdded: 0,
      totalRemoved: 1,
    })

    delta('+new\n')
    expect(currentFileEdit()).toMatchObject({
      changes: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n', added: 1, removed: 1 }],
      totalAdded: 1,
      totalRemoved: 1,
    })
  })

  it('增量被切在半行也不会算错 —— 计数看的是拼接后的全文', () => {
    started({ path: 'src/a.ts' })

    // 一个 `+new` 被切成三段送来。逐段计数会把 `+ne` 数成一行、`w` 又数一行;
    // 只有对拼接后的字符串重算才得到 1。
    delta('+ne')
    delta('w')
    delta('\n')

    expect(currentFileEdit()).toMatchObject({
      changes: [{ diff: '+new\n', added: 1, removed: 0 }],
      totalAdded: 1,
    })
  })

  it('started 没给 path 时也不丢增量,只是路径先空着', () => {
    started({})

    delta('-old\n')

    expect(currentFileEdit().changes).toEqual([
      { path: '', operation: 'edit', diff: '-old\n', added: 0, removed: 1 },
    ])
  })

  it('completed 的结构化 changes 覆盖掉流式占位', () => {
    started({ path: 'src/a.ts' })
    delta('-old\n')

    applyEvent({
      type: 'item_completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'fc-1',
      itemType: 'fileEdit',
      final: {
        changes: [
          { path: 'src/a.ts', operation: 'edit', diff: '@@ -1 +1 @@\n-old\n+new\n', added: 1, removed: 1 },
        ],
        totalAdded: 1,
        totalRemoved: 1,
      },
    })

    expect(currentFileEdit()).toMatchObject({
      changes: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n', added: 1, removed: 1 }],
      totalAdded: 1,
      totalRemoved: 1,
    })
  })
})
