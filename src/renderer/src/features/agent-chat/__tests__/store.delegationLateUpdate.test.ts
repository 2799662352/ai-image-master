import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentChatStore } from '../store'
import type { AgentStreamEvent } from '../../../../../types/agent'

/**
 * Late updates to a delegation card must land on the card, not on whatever the
 * user said next.
 *
 * Sub-agents outlive the parent turn — that is the whole reason cancelling has
 * to cascade — so their token reports and terminal status arrive after
 * `turn/completed`, sometimes after the user has typed again. The item-delta
 * path upserts into the LAST assistant message and creates the item when it is
 * missing, which turned those late merges into a phantom, contentless
 * delegation card attached to the new exchange.
 */

function applyEvent(event: AgentStreamEvent): void {
  ;(useAgentChatStore.getState() as unknown as {
    applyEvent(e: AgentStreamEvent): void
  }).applyEvent(event)
}

const delegationStarted: AgentStreamEvent = {
  type: 'item_started',
  threadId: 'thread-1',
  itemId: 'call_spawn',
  itemType: 'activity',
  payload: {
    kind: 'collabAgentToolCall',
    status: 'running',
    delegation: { tool: 'spawnAgent', agents: [{ threadId: 'child-1' }] },
  },
} as AgentStreamEvent

const lateUsage: AgentStreamEvent = {
  type: 'item_delta',
  threadId: 'thread-1',
  itemId: 'call_spawn',
  itemType: 'activity',
  patch: {
    kind: 'mergeFields',
    fields: {
      delegation: {
        tool: 'spawnAgent',
        agents: [{ threadId: 'child-1', status: 'completed', tokens: { input: 10, output: 2 } }],
      },
    },
  },
} as AgentStreamEvent

describe('agent chat store — late delegation updates', () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: [],
      isRunning: false,
      error: undefined,
      threadSlices: {},
      runningByThread: {},
    } as never)
  })

  it('updates the original card after the user has sent another message', () => {
    applyEvent(delegationStarted)
    applyEvent({ type: 'turn_completed', threadId: 'thread-1' } as AgentStreamEvent)
    // The user moves on while the sub-agent is still working.
    useAgentChatStore.setState({
      messages: [
        ...useAgentChatStore.getState().messages,
        { id: 'u2', role: 'user', createdAt: Date.now(), items: [] },
      ],
    } as never)

    applyEvent(lateUsage)

    const messages = useAgentChatStore.getState().messages
    const cards = messages.flatMap((message) =>
      message.items.filter((item) => item.type === 'activity' && item.id === 'call_spawn'),
    )
    // Exactly one card, still on the turn that spawned the agent.
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      delegation: { agents: [{ threadId: 'child-1', status: 'completed' }] },
    })
    expect(messages[messages.length - 1].items).toHaveLength(0)
  })
})
