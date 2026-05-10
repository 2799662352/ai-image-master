import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ActivityCard } from '../ActivityCard'
import type { ActivityItem } from '../../../../../../types/agent-timeline'

afterEach(cleanup)

function makePlan(): ActivityItem {
  return {
    type: 'activity',
    id: 'plan-1',
    startedAt: 0,
    kind: 'plan',
    label: 'plan',
    status: 'running',
    steps: [
      { text: 'Read source files', status: 'completed' },
      { text: 'Write the fix', status: 'in_progress' },
      { text: 'Run tests', status: 'pending' },
    ],
  }
}

describe('PlanCard (ActivityCard kind="plan")', () => {
  it('renders one row per step with the right glyph and counter', () => {
    render(<ActivityCard item={makePlan()} />)
    // counter 1/3 because only one is completed
    expect(screen.getByText('1/3')).toBeTruthy()
    expect(screen.getByText('Read source files')).toBeTruthy()
    expect(screen.getByText('Write the fix')).toBeTruthy()
    expect(screen.getByText('Run tests')).toBeTruthy()
  })

  it('strikes through completed steps', () => {
    render(<ActivityCard item={makePlan()} />)
    const completed = screen.getByText('Read source files').closest('li')
    expect(completed?.className).toContain('line-through')
    const inProgress = screen.getByText('Write the fix').closest('li')
    expect(inProgress?.className).not.toContain('line-through')
  })

  it('falls back to the generic activity pill when steps[] is empty', () => {
    const item: ActivityItem = {
      type: 'activity',
      id: 'plan-1',
      startedAt: 0,
      kind: 'plan',
      label: 'plan',
      status: 'success',
    }
    render(<ActivityCard item={item} />)
    // The plan-specific x/y counter shouldn't appear; the generic activity pill should.
    expect(screen.queryByText('0/0')).toBeNull()
  })
})
