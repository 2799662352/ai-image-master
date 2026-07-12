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

  it('turn_completed schedules repeated thread-list refreshes for async title updates', async () => {
    vi.useFakeTimers()
    const listThreads = vi.fn().mockResolvedValue([])
    ;(window as any).electronAPI = { agent: { listThreads } }
    try {
      useAgentChatStore.getState().applyEvent({ type: 'turn_completed', threadId: 'thread-1' })
      await vi.advanceTimersByTimeAsync(500)
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(listThreads).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores events from stale threads', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started', threadId: 'other-thread', itemId: 'x', itemType: 'text', payload: {},
    })
    expect(useAgentChatStore.getState().messages).toHaveLength(0)
  })

  // Regression for "工具调用信息 / mcp 调用信息 / 文档读取信息 没显示":
  // any unrecognized item.type must surface as an `activity` card so the
  // user sees evidence of tool / MCP / web-search / file-read activity.
  it('item_started for activity creates a generic activity item with kind/label/detail', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started',
      threadId: 'thread-1',
      itemId: 'mcp-1',
      itemType: 'activity',
      payload: { kind: 'mcpToolCall', label: 'mcp:context7/docs.fetch', detail: '{"q":"react"}', status: 'running' },
    })
    expect(lastMsg()!.items[0]).toMatchObject({
      type: 'activity',
      kind: 'mcpToolCall',
      label: 'mcp:context7/docs.fetch',
      detail: '{"q":"react"}',
      status: 'running',
    })
  })

  it('item_completed flips activity status from running to success and stamps endedAt', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'item_started',
      threadId: 'thread-1',
      itemId: 'mcp-1',
      itemType: 'activity',
      payload: { kind: 'mcpToolCall', label: 'mcp:fs/read', status: 'running' },
    })
    useAgentChatStore.getState().applyEvent({
      type: 'item_completed',
      threadId: 'thread-1',
      itemId: 'mcp-1',
      itemType: 'activity',
      final: { kind: 'mcpToolCall', status: 'success' },
    })
    const item = lastMsg()!.items[0]
    expect(item).toMatchObject({ type: 'activity', status: 'success' })
    expect(item.endedAt).toBeGreaterThan(0)
  })

  // Regression for "甚至没有个圈圈展示上下文压缩进度": Codex emits
  // `thread/tokenUsage/updated` notifications that we used to drop. They now
  // populate state.tokenUsage so the header donut can render.
  it('token_usage_updated stores cumulative usage on state', () => {
    useAgentChatStore.getState().applyEvent({
      type: 'token_usage_updated',
      threadId: 'thread-1',
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        contextWindow: 200_000,
        contextUsage: 1200,
      },
    })
    expect(useAgentChatStore.getState().tokenUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      contextWindow: 200_000,
      contextUsage: 1200,
    })
  })

  it('newThread resets tokenUsage so the meter clears between conversations', () => {
    useAgentChatStore.setState({
      tokenUsage: { inputTokens: 1, outputTokens: 1, contextWindow: 1000, contextUsage: 2 },
    })
    useAgentChatStore.getState().newThread()
    expect(useAgentChatStore.getState().tokenUsage).toBeUndefined()
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
  beforeEach(() => {
    localStorage.clear()
    useAgentChatStore.setState({
      modelReasoningEffortByModel: {},
      modelContextWindowByModel: {},
    } as never)
  })
  afterEach(() => localStorage.clear())

  it('exposes a default model id', () => {
    expect(useAgentChatStore.getState().selectedModelId).toBe(DEFAULT_MODEL_ID)
  })

  it('persists setSelectedModel to localStorage', () => {
    useAgentChatStore.getState().setSelectedModel('gpt-5.6-sol')
    expect(useAgentChatStore.getState().selectedModelId).toBe('gpt-5.6-sol')
    expect(localStorage.getItem('agent.selectedModel:v2')).toBe('gpt-5.6-sol')
    expect(localStorage.getItem('catimation.agent.selectedModel')).toBeNull()
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
      modelReasoningEffortByModel: {},
    })

    await useAgentChatStore.getState().send()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      content: 'hello',
      model: 'gpt-4o',
    })
  })

  it('forwards a per-model Max reasoning effort on an ordinary send', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ threadId: 'tx' })
    ;(window as any).electronAPI = {
      agent: {
        sendMessage,
        cancel: vi.fn().mockResolvedValue(undefined),
      },
    }
    useAgentChatStore.setState({
      threadId: undefined,
      input: 'deep review',
      attachments: [],
      messages: [],
      isRunning: false,
      selectedModelId: 'gpt-5.6-sol',
      modelReasoningEffortByModel: { 'gpt-5.6-sol': 'max' },
    })

    await useAgentChatStore.getState().send()

    expect(sendMessage.mock.calls[0][0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
    })
  })

  it('omits reasoningEffort from an ordinary Auto payload', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ threadId: 'tx' })
    ;(window as any).electronAPI = {
      agent: {
        sendMessage,
        cancel: vi.fn().mockResolvedValue(undefined),
      },
    }
    useAgentChatStore.setState({
      threadId: undefined,
      input: 'use provider default',
      attachments: [],
      messages: [],
      isRunning: false,
      selectedModelId: 'gpt-5.6-sol',
      modelReasoningEffortByModel: { 'gpt-5.6-sol': 'auto' },
    })

    await useAgentChatStore.getState().send()

    const payload = sendMessage.mock.calls[0][0]
    expect(payload.model).toBe('gpt-5.6-sol')
    expect(Object.prototype.hasOwnProperty.call(payload, 'reasoningEffort')).toBe(false)
  })
})

describe('useAgentChatStore — attachment URI synthesis (regression: empty src)', () => {
  // Repros the bug where MentionInput → addAttachment passes `buffer` (no
  // `path`), and send() previously wrote `uri: a.path ?? ''`, causing
  // `<img src="">` and the React "An empty string was passed to the src
  // attribute" warning. The fix is buildAttachmentUri (blob URL fallback)
  // plus a 'image' → 'file' kind downgrade when no usable URI is available.
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('builds a non-empty blob URL for buffer-only image attachments', async () => {
    const created: string[] = []
    const realCreate = URL.createObjectURL
    URL.createObjectURL = vi.fn(() => {
      const u = `blob:test/${created.length}`
      created.push(u)
      return u
    }) as typeof URL.createObjectURL

    const sendMessage = vi.fn().mockResolvedValue({ threadId: 'tx' })
    ;(window as any).electronAPI = {
      agent: { sendMessage, cancel: vi.fn() },
    }

    try {
      useAgentChatStore.setState({
        threadId: undefined,
        input: 'hi',
        messages: [],
        isRunning: false,
        attachments: [
          { name: 'pic.png', mime: 'image/png', size: 4, buffer: new Uint8Array([1, 2, 3, 4]).buffer },
        ],
      })

      await useAgentChatStore.getState().send()

      const userMsg = useAgentChatStore.getState().messages[0]
      expect(userMsg?.role).toBe('user')
      const att = userMsg?.items.find((i) => i.type === 'attachment')
      expect(att && att.type === 'attachment').toBe(true)
      if (att?.type === 'attachment') {
        expect(att.attachments).toHaveLength(1)
        expect(att.attachments[0].kind).toBe('image')
        expect(att.attachments[0].uri).toMatch(/^blob:/)
        expect(att.attachments[0].uri.length).toBeGreaterThan(0)
      }
      expect(created.length).toBe(1)
    } finally {
      URL.createObjectURL = realCreate
    }
  })

  it('downgrades to file kind (no <img>) when neither buffer nor path is available', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ threadId: 'tx' })
    ;(window as any).electronAPI = {
      agent: { sendMessage, cancel: vi.fn() },
    }

    useAgentChatStore.setState({
      threadId: undefined,
      input: 'hi',
      messages: [],
      isRunning: false,
      attachments: [
        // No buffer, no path: the renderer can't load anything meaningful
        // for this row, so we MUST NOT claim it's an image.
        { name: 'broken.png', mime: 'image/png', size: 0 },
      ],
    })

    await useAgentChatStore.getState().send()

    const att = useAgentChatStore
      .getState()
      .messages[0]?.items.find((i) => i.type === 'attachment')
    if (att?.type === 'attachment') {
      expect(att.attachments[0].kind).toBe('file')
      expect(att.attachments[0].uri).toBe('')
    } else {
      throw new Error('expected an attachment item')
    }
  })
})
