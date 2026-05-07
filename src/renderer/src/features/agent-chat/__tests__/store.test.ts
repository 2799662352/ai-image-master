// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import { DEFAULT_MODEL_ID } from '../models'
import type { Message } from '../../../../../types/agent-timeline'

function lastMsg(): Message | undefined {
  const msgs = useAgentChatStore.getState().messages
  return msgs[msgs.length - 1]
}

describe('useAgentChatStore — timeline items', () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      threadId: 'thread-1',
      messages: [],
      isRunning: true,
      error: undefined,
      panelWidth: 420,
    })
  })

  it('item_started creates an assistant message with a text item', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started', threadId: 'thread-1', itemId: 'msg-1', itemType: 'text', payload: {},
    })
    const msg = lastMsg()!
    expect(msg.role).toBe('assistant')
    expect(msg.items).toHaveLength(1)
    expect(msg.items[0]).toMatchObject({ type: 'text', id: 'msg-1', content: '' })
  })

  it('item_delta appends text to existing text item', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started', threadId: 'thread-1', itemId: 'msg-1', itemType: 'text', payload: {},
    })
    useAgentChatStore.getState().applyEvent({
      type: 'item_delta', threadId: 'thread-1', itemId: 'msg-1', itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'hello ' },
    })
    useAgentChatStore.getState().applyEvent({
      type: 'item_delta', threadId: 'thread-1', itemId: 'msg-1', itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'world' },
    })
    expect(lastMsg()!.items[0]).toMatchObject({ content: 'hello world' })
  })

  it('item_started for shell creates a shell item', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started', threadId: 'thread-1', itemId: 'cmd-1', itemType: 'shell',
      payload: { command: 'ls', cwd: '/tmp' },
    })
    expect(lastMsg()!.items[0]).toMatchObject({
      type: 'shell', command: 'ls', cwd: '/tmp', stdout: '', stderr: '',
    })
  })

  it('item_delta appends to shell stdout', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started', threadId: 'thread-1', itemId: 'cmd-1', itemType: 'shell',
      payload: { command: 'echo hi' },
    })
    useAgentChatStore.getState().applyEvent({
      type: 'item_delta', threadId: 'thread-1', itemId: 'cmd-1', itemType: 'shell',
      patch: { kind: 'appendText', field: 'stdout', text: 'hi\n' },
    })
    expect(lastMsg()!.items[0]).toMatchObject({ stdout: 'hi\n' })
  })

  it('item_completed sets exitCode on shell item', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started', threadId: 'thread-1', itemId: 'cmd-1', itemType: 'shell',
      payload: { command: 'ls' },
    })
    useAgentChatStore.getState().applyEvent({
      type: 'item_completed', threadId: 'thread-1', itemId: 'cmd-1', itemType: 'shell',
      final: { exitCode: 0 },
    })
    expect(lastMsg()!.items[0]).toMatchObject({ exitCode: 0 })
    expect(lastMsg()!.items[0].endedAt).toBeGreaterThan(0)
  })

  it('turn_completed sets isRunning to false', () => {
    useAgentChatStore.getState().applyEvent({ type: 'turn_completed', threadId: 'thread-1' })
    expect(useAgentChatStore.getState().isRunning).toBe(false)
  })

  it('ignores events from stale threads', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started', threadId: 'other-thread', itemId: 'x', itemType: 'text', payload: {},
    })
    expect(useAgentChatStore.getState().messages).toHaveLength(0)
  })
})

describe('useAgentChatStore — panelWidth', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('defaults to 420', () => {
    expect(useAgentChatStore.getState().panelWidth).toBe(420)
  })

  it('setPanelWidth clamps to [360, 720]', () => {
    useAgentChatStore.getState().setPanelWidth(200)
    expect(useAgentChatStore.getState().panelWidth).toBe(360)
    useAgentChatStore.getState().setPanelWidth(999)
    expect(useAgentChatStore.getState().panelWidth).toBe(720)
  })
})

describe('useAgentChatStore selected model', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('exposes a default model id', () => {
    expect(useAgentChatStore.getState().selectedModelId).toBe(DEFAULT_MODEL_ID)
  })

  it('persists setSelectedModel to localStorage', () => {
    useAgentChatStore.getState().setSelectedModel('o3-pro')
    expect(useAgentChatStore.getState().selectedModelId).toBe('o3-pro')
    expect(localStorage.getItem('catimation.agent.selectedModel')).toBe('o3-pro')
  })

  it('forwards selectedModelId via send → electronAPI.agent.sendMessage', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ threadId: 'tx' })
    ;(window as any).electronAPI = {
      agent: {
        sendMessage,
        cancel: vi.fn().mockResolvedValue(undefined),
      },
    }
    useAgentChatStore.setState({
      threadId: undefined,
      input: 'hello',
      attachments: [],
      messages: [],
      isRunning: false,
      selectedModelId: 'gpt-4o',
    })

    await useAgentChatStore.getState().send()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      content: 'hello',
      model: 'gpt-4o',
    })
  })
})
