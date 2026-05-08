import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentReference } from '../../../../../../types/agent-reference'
import { ReferenceChip } from '../ReferenceChip'

afterEach(cleanup)

const ref: AgentReference = {
  id: 'url:https://example.com',
  type: 'url',
  label: 'example.com',
  source: { kind: 'url', url: 'https://example.com' },
  status: 'ready',
  openBehavior: 'url',
}

describe('ReferenceChip', () => {
  it('renders the type and label', () => {
    render(<ReferenceChip reference={ref} />)
    expect(screen.getByText('url')).toBeTruthy()
    expect(screen.getByText('example.com')).toBeTruthy()
  })

  it('invokes onOpen when clicked', () => {
    const onOpen = vi.fn()
    render(<ReferenceChip reference={ref} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledWith(ref)
  })
})
