import { describe, expect, it } from 'vitest'
import { CodexNotificationRouter } from '../codexNotificationRouter'

describe('CodexNotificationRouter', () => {
  it('translates item/agentMessage/delta into item_delta', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/agentMessage/delta', {
      threadId: 'urn:uuid:t1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      delta: 'hello',
    })
    expect(event).toEqual({
      type: 'item_delta',
      threadId: 'urn:uuid:t1',
      itemId: 'msg-1',
      itemType: 'text',
      patch: { kind: 'appendText', field: 'content', text: 'hello' },
    })
  })

  it('translates reasoning text deltas to item_delta', () => {
    const router = new CodexNotificationRouter()
    expect(
      router.route('item/reasoning/textDelta', { threadId: 't', turnId: 'u', itemId: 'r-1', delta: 'r1' }),
    ).toEqual({
      type: 'item_delta',
      threadId: 't',
      itemId: 'r-1',
      itemType: 'reasoning',
      patch: { kind: 'appendText', field: 'content', text: 'r1' },
    })
    expect(
      router.route('item/reasoning/summaryTextDelta', { threadId: 't', turnId: 'u', itemId: 'r-1', delta: 'r2' }),
    ).toEqual({
      type: 'item_delta',
      threadId: 't',
      itemId: 'r-1',
      itemType: 'reasoning',
      patch: { kind: 'appendText', field: 'content', text: 'r2' },
    })
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
    ).toEqual({ type: 'error', threadId: 't', error: 'boom' })
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
    it('emits item_delta with full text when no deltas streamed for that itemId', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'agentMessage', id: 'msg-7', text: 'Hello world' },
      })
      expect(event).toEqual({
        type: 'item_delta',
        threadId: 't',
        itemId: 'msg-7',
        itemType: 'text',
        patch: { kind: 'appendText', field: 'content', text: 'Hello world' },
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

      // 'b' was NOT streamed → fallback fires as item_delta
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'agentMessage', id: 'b', text: 'B-full' },
      })
      expect(event).toMatchObject({
        type: 'item_delta',
        itemId: 'b',
        itemType: 'text',
        patch: { kind: 'appendText', field: 'content', text: 'B-full' },
      })
    })
  })

  describe('shell item lifecycle', () => {
    it('emits item_started for commandExecution', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'commandExecution', id: 'cmd-1', command: 'ls -la', cwd: '/tmp' },
      })
      expect(event).toEqual({
        type: 'item_started',
        threadId: 't',
        itemId: 'cmd-1',
        itemType: 'shell',
        payload: { command: 'ls -la', cwd: '/tmp' },
      })
    })

    it('emits item_delta for commandExecution stdout', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/commandExecution/output', {
        threadId: 't',
        turnId: 'u',
        itemId: 'cmd-1',
        stream: 'stdout',
        data: 'file.txt\n',
      })
      expect(event).toEqual({
        type: 'item_delta',
        threadId: 't',
        itemId: 'cmd-1',
        itemType: 'shell',
        patch: { kind: 'appendText', field: 'stdout', text: 'file.txt\n' },
      })
    })

    it('emits item_delta for commandExecution stderr', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/commandExecution/output', {
        threadId: 't',
        turnId: 'u',
        itemId: 'cmd-1',
        stream: 'stderr',
        data: 'warn: ...',
      })
      expect(event).toMatchObject({
        type: 'item_delta',
        patch: { kind: 'appendText', field: 'stderr', text: 'warn: ...' },
      })
    })

    it('emits item_completed for commandExecution', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'commandExecution', id: 'cmd-1', exitCode: 0 },
      })
      expect(event).toEqual({
        type: 'item_completed',
        threadId: 't',
        itemId: 'cmd-1',
        itemType: 'shell',
        final: { exitCode: 0 },
      })
    })
  })

  describe('fileChange item lifecycle', () => {
    it('emits item_started for fileChange', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'fileChange', id: 'fc-1', status: 'pending' },
      })
      expect(event).toEqual({
        type: 'item_started',
        threadId: 't',
        itemId: 'fc-1',
        itemType: 'fileEdit',
        payload: {},
      })
    })

    it('emits item_completed for fileChange with changes', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: {
          type: 'fileChange',
          id: 'fc-1',
          status: 'completed',
          changes: [
            { path: 'src/foo.ts', kind: 'modify', unifiedDiff: '@@ -1,1 +1,2 @@\n-old\n+new1\n+new2' },
          ],
        },
      })
      expect(event).toMatchObject({
        type: 'item_completed',
        itemId: 'fc-1',
        itemType: 'fileEdit',
      })
    })
  })

  describe('reasoning completion', () => {
    it('emits item_completed for reasoning items', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'reasoning', id: 'r-1', summary: [], content: [] },
      })
      expect(event).toEqual({
        type: 'item_completed',
        threadId: 't',
        itemId: 'r-1',
        itemType: 'reasoning',
        final: {},
      })
    })
  })
})
