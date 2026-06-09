import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentStreamEvent } from '../../../../../types/agent'
import type { ActivityItem } from '../../../../../types/agent-timeline'
import { useAgentChatStore } from '../store'

function applyEvent(event: AgentStreamEvent): void {
  useAgentChatStore.getState().applyEvent(event)
}

function currentItems(): ActivityItem[] {
  const messages = useAgentChatStore.getState().messages
  expect(messages).toHaveLength(1)
  expect(messages[0].role).toBe('assistant')
  return messages[0].items.filter((i): i is ActivityItem => i.type === 'activity')
}

/**
 * Plan rendering flows through the router's `turn/plan/updated` translation:
 * the router emits `item_delta` events with a synthetic `itemId =
 * plan:${turnId}` so the existing `upsertItemInLastMessage` mergeFields path
 * upserts a single PlanCard-shaped ActivityItem. These tests exercise the
 * store side of that contract end-to-end.
 *
 * Regression coverage for the v0.130.0 bug where the chat panel never
 * showed plan lists because the router listened for `item.type === 'plan'`
 * with `item.plan: [...]` — a field that doesn't exist on the wire.
 */
describe('agent chat store — plan rendering', () => {
  beforeEach(() => {
    // Active view = thread-1, matching the streamed plan events' threadId.
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

  it('creates a single plan ActivityItem on first turn/plan/updated and updates it on subsequent ones', () => {
    // First Codex `update_plan` call — kick off with one pending step.
    applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'plan:turn-1',
      itemType: 'activity',
      patch: {
        kind: 'mergeFields',
        fields: {
          kind: 'plan',
          label: 'plan',
          steps: [
            { text: 'Read source', status: 'in_progress' },
            { text: 'Write fix', status: 'pending' },
          ],
          status: 'running',
        },
      },
    })

    const initial = currentItems()
    expect(initial).toHaveLength(1)
    expect(initial[0]).toMatchObject({
      type: 'activity',
      id: 'plan:turn-1',
      kind: 'plan',
      status: 'running',
      steps: [
        { text: 'Read source', status: 'in_progress' },
        { text: 'Write fix', status: 'pending' },
      ],
    })

    // Codex re-emits `update_plan` after the first step completes — same
    // synthetic itemId so the store should patch in place, not duplicate.
    applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'plan:turn-1',
      itemType: 'activity',
      patch: {
        kind: 'mergeFields',
        fields: {
          kind: 'plan',
          label: 'plan',
          steps: [
            { text: 'Read source', status: 'completed' },
            { text: 'Write fix', status: 'in_progress' },
          ],
          status: 'running',
        },
      },
    })

    const after = currentItems()
    expect(after).toHaveLength(1)
    expect(after[0].steps).toEqual([
      { text: 'Read source', status: 'completed' },
      { text: 'Write fix', status: 'in_progress' },
    ])
  })

  it('flips status to success on the final turn/plan/updated when all steps complete', () => {
    applyEvent({
      type: 'item_delta',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'plan:turn-1',
      itemType: 'activity',
      patch: {
        kind: 'mergeFields',
        fields: {
          kind: 'plan',
          label: 'plan',
          steps: [{ text: 'A', status: 'completed' }],
          status: 'success',
        },
      },
    })

    expect(currentItems()[0].status).toBe('success')
  })
})
