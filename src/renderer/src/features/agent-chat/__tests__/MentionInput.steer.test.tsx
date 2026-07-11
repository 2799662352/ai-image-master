import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      agent: { sendMessage: vi.fn(), steer: vi.fn(), cancel: vi.fn() },
      fs: { stat: vi.fn(async () => ({ ok: true, size: 1, mime: 'text/plain', mtime: 1 })) },
    },
    configurable: true,
  })
  useAgentChatStore.setState({
    input: '',
    attachments: [],
    pendingReferences: [],
    editingMessageId: null,
    isRunning: false,
    threadId: undefined,
  } as never)
})

describe('MentionInput — 运行中插话 (turn/steer) routing', () => {
  it('routes Enter/submit to steer (not send) while a turn is running', () => {
    const steer = vi.fn(async () => undefined)
    const send = vi.fn(async () => undefined)
    useAgentChatStore.setState({
      isRunning: true,
      threadId: 'thread-1',
      input: 'actually, focus on the failing test',
      steer,
      send,
    } as never)

    render(<MentionInput />)
    // While running the primary button is a live "Steer" submit, not a disabled "Running".
    const btn = screen.getByRole('button', { name: 'Steer' })
    expect((btn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(btn)

    expect(steer).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps the composer input enabled while running so the user can type an interjection', () => {
    useAgentChatStore.setState({ isRunning: true, threadId: 'thread-1', input: '' } as never)
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox')
    expect((textarea as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('orders and disables the model, collaboration, and image controls while running', () => {
    useAgentChatStore.setState({
      isRunning: true,
      threadId: 'thread-1',
      input: '',
      collabModeKind: 'default',
      collabModeByThread: { 'thread-1': 'default' },
      collabModePendingByThread: {},
    } as never)
    render(<MentionInput />)

    const model = screen.getByRole('button', { name: /GPT-/ })
    const collaboration = screen.getByRole('button', { name: '切换到 Plan' })
    const image = screen.getByRole('button', { name: /出图渠道/ })

    expect(model.compareDocumentPosition(collaboration) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(collaboration.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect((model as HTMLButtonElement).disabled).toBe(true)
    expect((collaboration as HTMLButtonElement).disabled).toBe(true)
    expect((image as HTMLButtonElement).disabled).toBe(true)
  })

  it('still routes to send when idle', () => {
    const steer = vi.fn(async () => undefined)
    const send = vi.fn(async () => undefined)
    useAgentChatStore.setState({
      isRunning: false,
      threadId: 'thread-1',
      input: 'a brand new request',
      steer,
      send,
    } as never)

    render(<MentionInput />)
    const btn = screen.getByRole('button', { name: 'Send' })
    fireEvent.click(btn)

    expect(send).toHaveBeenCalledTimes(1)
    expect(steer).not.toHaveBeenCalled()
  })

  it('plain Enter sends (submitAction); Shift+Enter does not', () => {
    const send = vi.fn(async () => undefined)
    useAgentChatStore.setState({
      isRunning: false,
      threadId: 'thread-1',
      input: 'hello there',
      send,
    } as never)

    render(<MentionInput />)
    const textarea = screen.getByRole('textbox')

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(send).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not send on Enter while an IME composition is active', () => {
    const send = vi.fn(async () => undefined)
    useAgentChatStore.setState({ isRunning: false, threadId: 'thread-1', input: '你好', send } as never)

    render(<MentionInput />)
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps a Stop button available to interrupt while running', () => {
    const cancel = vi.fn(async () => undefined)
    useAgentChatStore.setState({ isRunning: true, threadId: 'thread-1', input: '', cancel } as never)
    render(<MentionInput />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
