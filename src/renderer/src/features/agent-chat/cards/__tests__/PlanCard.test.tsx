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
  it('renders one row per step with the "X of Y Done" counter (image-1 spec)', () => {
    render(<ActivityCard item={makePlan()} />)
    // Header counter follows the image-1 wording exactly.
    expect(screen.getByText('1 of 3 Done')).toBeTruthy()
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

  it('renders a "Creating plan…" placeholder card when steps[] is empty', () => {
    // Plan tool fired but no structured / extractable steps yet. Earlier
    // behaviour fell through to the generic chip — the user explicitly
    // called that out as wrong UX. Slot is now always reserved.
    const item: ActivityItem = {
      type: 'activity',
      id: 'plan-1',
      startedAt: 0,
      kind: 'plan',
      label: 'plan',
      status: 'running',
    }
    render(<ActivityCard item={item} />)
    expect(screen.getByText('Creating plan…')).toBeTruthy()
    // Generic chip's label "plan" shouldn't be visible since PlanCard
    // owns the slot now.
    expect(screen.queryByText(/^TOOL$/)).toBeNull()
  })

  it('surfaces the model explanation inside the placeholder row when available', () => {
    const item: ActivityItem = {
      type: 'activity',
      id: 'plan-2',
      startedAt: 0,
      kind: 'plan',
      label: 'plan',
      status: 'running',
      detail: '这是一个用于展示 todo list 的小计划。',
    }
    render(<ActivityCard item={item} />)
    expect(screen.getByText('这是一个用于展示 todo list 的小计划。')).toBeTruthy()
  })
})
