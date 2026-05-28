import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../../../types/agent-timeline'
import type { CodexApprovalRequest } from '../../../../../types/agent'

// Capture Virtuoso props per render so tests can assert wiring without
// actually rendering the virtualized container (happy-dom lacks the
// layout APIs Virtuoso needs). We also expose escape-hatches to trigger
// atBottomStateChange from inside tests.
const virtuosoProps: Array<Record<string, unknown>> = []
const scrollToIndexSpy = vi.fn()

vi.mock('react-virtuoso', () => {
  return {
    Virtuoso: forwardRef(function VirtuosoMock(props: Record<string, unknown>, ref) {
      virtuosoProps.push(props)
      useImperativeHandle(ref, () => ({
        scrollToIndex: scrollToIndexSpy,
      }))
      const atBottomStateChange = props.atBottomStateChange as
        | ((b: boolean) => void)
        | undefined
      return (
        <div data-testid="virtuoso-mock">
          <button
            data-testid="virtuoso-leave-bottom"
            onClick={() => atBottomStateChange?.(false)}
          />
          <button
            data-testid="virtuoso-enter-bottom"
            onClick={() => atBottomStateChange?.(true)}
          />
        </div>
      )
    }),
  }
})

// Don't try to render OverlayScrollbars in tests — it walks the DOM and
// blows up in happy-dom. Mock to a passthrough.
vi.mock('overlayscrollbars-react', () => ({
  OverlayScrollbarsComponent: forwardRef(function OSMock(props: { children?: React.ReactNode }, _ref) {
    return <div data-testid="os-scroller">{props.children}</div>
  }),
}))

import { MessageList } from '../MessageList'

function makeMessage(id: string, role: 'user' | 'assistant' = 'assistant'): Message {
  return {
    id,
    role,
    createdAt: Date.now(),
    items: [{ id: `${id}-i`, type: 'text', content: `body ${id}` }],
  }
}

const baseProps = {
  threadId: 'thread-1',
  messages: [makeMessage('m1'), makeMessage('m2'), makeMessage('m3')],
  editingMessageId: undefined,
  pendingApprovals: [] as CodexApprovalRequest[],
  error: undefined as string | undefined,
  onRespondApproval: vi.fn(),
}

beforeEach(() => {
  virtuosoProps.length = 0
  scrollToIndexSpy.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('MessageList', () => {
  it('opens at the bottom: passes initialTopMostItemIndex = messages.length - 1 to Virtuoso', () => {
    render(<MessageList {...baseProps} />)
    expect(virtuosoProps).toHaveLength(1)
    expect(virtuosoProps[0].initialTopMostItemIndex).toBe(2)
  })

  it('initialTopMostItemIndex clamps to 0 when there are no messages (no negative index)', () => {
    render(<MessageList {...baseProps} messages={[]} />)
    expect(virtuosoProps[0].initialTopMostItemIndex).toBe(0)
  })

  it('hands followOutput="smooth" to Virtuoso so AI stream tails the viewport', () => {
    render(<MessageList {...baseProps} />)
    expect(virtuosoProps[0].followOutput).toBe('smooth')
  })

  it('uses message.id as stable item key (resilient to streaming token updates)', () => {
    render(<MessageList {...baseProps} />)
    const computeItemKey = virtuosoProps[0].computeItemKey as (i: number, m: Message) => string
    expect(computeItemKey(0, baseProps.messages[0])).toBe('m1')
    expect(computeItemKey(2, baseProps.messages[2])).toBe('m3')
  })

  it('does NOT render the floating scroll-to-bottom button while the user is at the bottom', () => {
    render(<MessageList {...baseProps} />)
    expect(screen.queryByRole('button', { name: /scroll to latest/i })).toBeNull()
  })

  it('shows the floating button after Virtuoso reports atBottomStateChange(false), then hides it again on (true)', () => {
    render(<MessageList {...baseProps} />)
    expect(screen.queryByRole('button', { name: /scroll to latest/i })).toBeNull()

    act(() => {
      fireEvent.click(screen.getByTestId('virtuoso-leave-bottom'))
    })
    expect(screen.getByRole('button', { name: /scroll to latest/i })).toBeTruthy()

    act(() => {
      fireEvent.click(screen.getByTestId('virtuoso-enter-bottom'))
    })
    expect(screen.queryByRole('button', { name: /scroll to latest/i })).toBeNull()
  })

  it('clicking the floating button calls virtuosoRef.scrollToIndex with index="LAST" + smooth behavior', () => {
    render(<MessageList {...baseProps} />)
    act(() => {
      fireEvent.click(screen.getByTestId('virtuoso-leave-bottom'))
    })
    fireEvent.click(screen.getByRole('button', { name: /scroll to latest/i }))
    expect(scrollToIndexSpy).toHaveBeenCalledTimes(1)
    expect(scrollToIndexSpy).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'LAST', behavior: 'smooth' }),
    )
  })
})
