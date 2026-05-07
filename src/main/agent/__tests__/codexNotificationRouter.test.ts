import { describe, expect, it } from 'vitest'
import { CodexNotificationRouter } from '../codexNotificationRouter'

describe('CodexNotificationRouter', () => {
  it('translates item/agentMessage/delta into message_delta', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/agentMessage/delta', {
      threadId: 'urn:uuid:t1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      delta: 'hello',
    })
    expect(event).toEqual({
      type: 'message_delta',
      threadId: 'urn:uuid:t1',
      turnId: 'turn-1',
      delta: 'hello',
    })
  })

  it('translates reasoning text deltas to reasoning_delta', () => {
    const router = new CodexNotificationRouter()
    expect(
      router.route('item/reasoning/textDelta', { threadId: 't', turnId: 'u', delta: 'r1' }),
    ).toEqual({ type: 'reasoning_delta', threadId: 't', turnId: 'u', delta: 'r1' })
    expect(
      router.route('item/reasoning/summaryTextDelta', { threadId: 't', turnId: 'u', delta: 'r2' }),
    ).toEqual({ type: 'reasoning_delta', threadId: 't', turnId: 'u', delta: 'r2' })
  })

  it('translates turn/completed', () => {
    const router = new CodexNotificationRouter()
    expect(
      router.route('turn/completed', { threadId: 't', turn: { id: 'turn-9' } }),
    ).toEqual({ type: 'turn_completed', threadId: 't', turnId: 'turn-9' })
  })

  it('translates error notifications', () => {
    const router = new CodexNotificationRouter()
    expect(
      router.route('error', { threadId: 't', turnId: 'u', error: { message: 'boom' } }),
    ).toEqual({ type: 'error', threadId: 't', turnId: 'u', error: 'boom' })
  })

  it('returns null for unrelated notifications', () => {
    const router = new CodexNotificationRouter()
    expect(router.route('thread/started', { threadId: 't' })).toBeNull()
    expect(router.route('thread/status/changed', { threadId: 't' })).toBeNull()
    expect(router.route('turn/started', { threadId: 't' })).toBeNull()
    expect(router.route('item/started', { threadId: 't', turnId: 'u', item: {} })).toBeNull()
    expect(router.route('warning', { message: 'x' })).toBeNull()
  })

  describe('item/completed agentMessage fallback', () => {
    it('emits message_delta with full text when no deltas streamed for that itemId', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'agentMessage', id: 'msg-7', text: 'Hello world' },
      })
      expect(event).toEqual({
        type: 'message_delta',
        threadId: 't',
        turnId: 'u',
        delta: 'Hello world',
      })
    })

    it('drops the fallback when deltas already streamed for that itemId (avoids duplication)', () => {
      const router = new CodexNotificationRouter()
      router.route('item/agentMessage/delta', {
        threadId: 't',
        turnId: 'u',
        itemId: 'msg-7',
        delta: 'Hello ',
      })
      router.route('item/agentMessage/delta', {
        threadId: 't',
        turnId: 'u',
        itemId: 'msg-7',
        delta: 'world',
      })
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'agentMessage', id: 'msg-7', text: 'Hello world' },
      })
      expect(event).toBeNull()
    })

    it('does not emit fallback for non-agentMessage item types', () => {
      const router = new CodexNotificationRouter()
      expect(router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'reasoning', id: 'r-1', summary: [], content: [] },
      })).toBeNull()
      expect(router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'commandExecution', id: 'cmd-1', command: 'ls' },
      })).toBeNull()
    })

    it('drops empty agentMessage text', () => {
      const router = new CodexNotificationRouter()
      expect(router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'agentMessage', id: 'msg-8', text: '' },
      })).toBeNull()
    })

    it('tracks each itemId independently', () => {
      const router = new CodexNotificationRouter()
      router.route('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'a', delta: 'A' })

      // 'a' was streamed → fallback dropped
      expect(router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'agentMessage', id: 'a', text: 'A' },
      })).toBeNull()

      // 'b' was NOT streamed → fallback fires
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'agentMessage', id: 'b', text: 'B-full' },
      })
      expect(event).toMatchObject({ type: 'message_delta', delta: 'B-full' })
    })
  })
})
