import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivityItem } from '../../../../../../types/agent-timeline'
import { ActivityCard } from '../ActivityCard'

/**
 * The delegation card.
 *
 * When the model spawns sub-agents, the parent turn is the ONLY stream a chat
 * subscribes to — the children run on their own thread ids and their output
 * never reaches this conversation (see `AgentManager.handleUnroutedEvent`). All
 * the user would otherwise see is a nameless tool chip and a long pause.
 *
 * Everything rendered here comes off the parent's own `collabAgentToolCall`
 * item, whose `agentsStates` carries each child's status and final reply. Field
 * shapes are from measured wire payloads (`scripts/smoke-subagents.ts`).
 */

afterEach(cleanup)

function delegationItem(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    type: 'activity',
    id: 'call_spawn',
    startedAt: 1,
    kind: 'collabAgentToolCall',
    label: 'spawn agent',
    status: 'running',
    delegation: {
      tool: 'spawnAgent',
      prompt: 'Summarise the three reference images',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      agents: [{ threadId: '019fa267-0b39-7be1-a0c1-41de1462ff50' }],
    },
    ...overrides,
  } as ActivityItem
}

describe('ActivityCard delegation', () => {
  it('shows the task the sub-agent was given', () => {
    // Without this the user cannot tell delegated work from a stalled turn.
    render(<ActivityCard item={delegationItem()} />)

    expect(screen.getByText(/Summarise the three reference images/)).toBeTruthy()
  })

  it('shows each agent\'s reply once it reports back', () => {
    render(<ActivityCard item={delegationItem({
      status: 'success',
      endedAt: 2,
      label: 'wait',
      delegation: {
        tool: 'wait',
        agents: [
          { threadId: 'child-a', status: 'completed', message: 'found 3 faces' },
          { threadId: 'child-b', status: 'running' },
        ],
      },
    })} />)

    expect(screen.getByText(/found 3 faces/)).toBeTruthy()
    // Two agents means two rows, each identifiable.
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('counts the agents so a fan-out is legible at a glance', () => {
    render(<ActivityCard item={delegationItem({
      delegation: {
        tool: 'spawnAgent',
        agents: [{ threadId: 'a' }, { threadId: 'b' }, { threadId: 'c' }],
      },
    })} />)

    expect(screen.getByText(/3 agents/i)).toBeTruthy()
  })

  it('names the model when the spawn resolved one', () => {
    // Sub-agents can run a different model than the parent; billing surprises
    // start here, so the card says which one.
    render(<ActivityCard item={delegationItem()} />)

    expect(screen.getByText(/gpt-5\.5/)).toBeTruthy()
  })

  it('falls back to the generic chip for ordinary tool calls', () => {
    render(<ActivityCard item={{
      type: 'activity',
      id: 'mcp_1',
      startedAt: 1,
      kind: 'mcpToolCall',
      label: 'mcp:catimation/generate_image',
      status: 'running',
    } as ActivityItem} />)

    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText('mcp:catimation/generate_image')).toBeTruthy()
  })
})
