import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import type { ThreadGoal, ThreadGoalStatus } from '../../../../../types/codexGoals'
import type { AgentStreamEvent } from '../../../../../types/agent'

const THREAD = 'db-thread-1'

function makeGoal(status: ThreadGoalStatus, over: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    threadId: 'thr_codex',
    objective: 'ship it',
    status,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function updatedEvent(goal: ThreadGoal): AgentStreamEvent {
  return { type: 'goal_updated', threadId: THREAD, goal }
}

let setGoalApi: ReturnType<typeof vi.fn>

beforeEach(() => {
  setGoalApi = vi.fn().mockImplementation(async (_id: string, params: Record<string, unknown>) => ({
    ok: true,
    data: makeGoal((params.status as ThreadGoalStatus) ?? 'active', params),
  }))
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: { agent: { setGoal: setGoalApi } },
  }
  useAgentChatStore.setState({ threadId: THREAD, goalByThread: {}, notices: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('applyGoalEvent — state', () => {
  it('goal_updated stores the goal under its thread', () => {
    useAgentChatStore.getState().applyGoalEvent(updatedEvent(makeGoal('active')))
    expect(useAgentChatStore.getState().goalByThread[THREAD]?.status).toBe('active')
  })

  it('goal_cleared nulls the goal', () => {
    useAgentChatStore.setState({ goalByThread: { [THREAD]: makeGoal('active') } })
    useAgentChatStore.getState().applyGoalEvent({ type: 'goal_cleared', threadId: THREAD })
    expect(useAgentChatStore.getState().goalByThread[THREAD]).toBeNull()
  })
})

describe('applyGoalEvent — status-transition notices', () => {
  it('does NOT notify on a token-only update (status unchanged)', () => {
    const s = useAgentChatStore.getState()
    s.applyGoalEvent(updatedEvent(makeGoal('active', { tokensUsed: 10 })))
    s.applyGoalEvent(updatedEvent(makeGoal('active', { tokensUsed: 20, updatedAt: 2 })))
    expect(useAgentChatStore.getState().notices).toHaveLength(0)
  })

  it('notifies (warning) when the loop becomes blocked', () => {
    const s = useAgentChatStore.getState()
    s.applyGoalEvent(updatedEvent(makeGoal('active')))
    s.applyGoalEvent(updatedEvent(makeGoal('blocked', { updatedAt: 2 })))
    const n = useAgentChatStore.getState().notices[0]
    expect(n?.level).toBe('warning')
    expect(n?.message).toMatch(/受阻|blocked|resume/i)
  })

  it('notifies when budget is exhausted (budgetLimited)', () => {
    const s = useAgentChatStore.getState()
    s.applyGoalEvent(updatedEvent(makeGoal('active')))
    s.applyGoalEvent(updatedEvent(makeGoal('budgetLimited', { updatedAt: 2 })))
    expect(useAgentChatStore.getState().notices[0]?.message).toMatch(/预算|budget/i)
  })

  it('notifies when usage-limited', () => {
    const s = useAgentChatStore.getState()
    s.applyGoalEvent(updatedEvent(makeGoal('active')))
    s.applyGoalEvent(updatedEvent(makeGoal('usageLimited', { updatedAt: 2 })))
    expect(useAgentChatStore.getState().notices[0]?.message).toMatch(/用量|usage/i)
  })

  it('emits a completion report (with usage) when complete', () => {
    const s = useAgentChatStore.getState()
    s.applyGoalEvent(updatedEvent(makeGoal('active')))
    s.applyGoalEvent(
      updatedEvent(makeGoal('complete', { tokensUsed: 12000, timeUsedSeconds: 3660, updatedAt: 2 })),
    )
    const n = useAgentChatStore.getState().notices[0]
    expect(n?.level).toBe('info')
    expect(n?.message).toMatch(/完成|complete/i)
    // Final usage surfaced (12k tokens, 1h+).
    expect(n?.message).toMatch(/12k|12000/)
  })

  it('does not notify when a goal first appears already active (no prior state)', () => {
    useAgentChatStore.getState().applyGoalEvent(updatedEvent(makeGoal('active')))
    expect(useAgentChatStore.getState().notices).toHaveLength(0)
  })
})

describe('setGoalBudget', () => {
  it('sends only tokenBudget for an existing goal and stores the result', async () => {
    useAgentChatStore.setState({ goalByThread: { [THREAD]: makeGoal('active') } })
    await useAgentChatStore.getState().setGoalBudget(200000)
    expect(setGoalApi).toHaveBeenCalledWith(THREAD, { tokenBudget: 200000 })
    expect(useAgentChatStore.getState().goalByThread[THREAD]?.tokenBudget).toBe(200000)
  })

  it('warns and no-ops when there is no goal yet', async () => {
    await useAgentChatStore.getState().setGoalBudget(200000)
    expect(setGoalApi).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().notices[0]?.message).toMatch(/目标|goal/i)
  })
})
