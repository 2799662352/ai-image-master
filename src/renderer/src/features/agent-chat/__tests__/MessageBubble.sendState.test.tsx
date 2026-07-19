// Batch 3-A: delivery badge + failed-bubble retry affordance on user messages.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../../../../types/agent-timeline'
import { MessageBubble } from '../MessageBubble'
import { useAgentChatStore } from '../store'

const retryFailedMessage = vi.fn(async () => undefined)

beforeEach(() => {
  retryFailedMessage.mockClear()
  useAgentChatStore.setState({
    isRunning: false,
    editingMessageId: undefined,
    retryFailedMessage,
  })
})

afterEach(() => {
  cleanup()
})

function userMessage(sendState?: Message['sendState']): Message {
  return {
    id: 'u1',
    role: 'user',
    createdAt: Date.now(),
    items: [{ type: 'text', id: 'i1', startedAt: 1, content: 'hi' }],
    ...(sendState ? { sendState } : {}),
  }
}

describe('MessageBubble delivery states', () => {
  it('shows 发送中 while the send is in flight', () => {
    render(<MessageBubble message={userMessage('sending')} />)
    expect(screen.getByText('发送中')).toBeTruthy()
  })

  it('shows 已送达 once main admits the turn', () => {
    render(<MessageBubble message={userMessage('sent')} />)
    expect(screen.getByText('已送达')).toBeTruthy()
  })

  it('shows the failure banner with a working 重试 button', () => {
    render(<MessageBubble message={userMessage('failed')} />)
    expect(screen.getByText('发送失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }))
    expect(retryFailedMessage).toHaveBeenCalledWith('u1')
  })

  it('disables 重试 while another turn is running', () => {
    useAgentChatStore.setState({ isRunning: true })
    render(<MessageBubble message={userMessage('failed')} />)
    const button = screen.getByRole('button', { name: '重试发送' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('renders no badge for history messages without sendState', () => {
    render(<MessageBubble message={userMessage()} />)
    expect(screen.queryByText('发送中')).toBeNull()
    expect(screen.queryByText('已送达')).toBeNull()
    expect(screen.queryByText('发送失败')).toBeNull()
  })
})
