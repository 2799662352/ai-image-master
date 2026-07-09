import { describe, expect, it } from 'vitest'
import { CodexNotificationRouter } from '../codexNotificationRouter'

/**
 * Read-side of the official `clientUserMessageId` / `text_elements` loop
 * (app-server v2): the turn's canonical `userMessage` item echoes our
 * persisted row id as `clientId` plus the canonical content list. Instead of
 * dropping the completed echo entirely (started is still dropped — it must
 * never render a duplicate bubble), the router now surfaces an internal
 * `user_message_reconciled` event so AgentManager can reconcile the rollout's
 * canonical data (localImage paths, text_elements) back onto our DB row.
 */
describe('CodexNotificationRouter userMessage reconcile', () => {
  it('routes item/completed userMessage into user_message_reconciled', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/completed', {
      threadId: 't-1',
      turnId: 'u-1',
      item: {
        type: 'userMessage',
        id: 'item-9',
        clientId: 'msg-42',
        content: [
          {
            type: 'text',
            text: 'look at @foo please',
            text_elements: [{ byteRange: { start: 8, end: 12 }, placeholder: 'Foo Plugin' }],
          },
          { type: 'localImage', path: 'C:\\uploads\\a.png' },
          { type: 'image', url: 'data:image/png;base64,xxx' },
        ],
      },
    })
    expect(event).toEqual({
      type: 'user_message_reconciled',
      threadId: 't-1',
      turnId: 'u-1',
      reconcile: {
        codexItemId: 'item-9',
        clientId: 'msg-42',
        localImages: ['C:\\uploads\\a.png'],
        textElements: [{ byteRange: { start: 8, end: 12 }, placeholder: 'Foo Plugin' }],
      },
    })
  })

  it('still emits the event without clientId (manager side decides to skip)', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/completed', {
      threadId: 't-1',
      turnId: 'u-1',
      item: { type: 'userMessage', id: 'item-9', content: [{ type: 'text', text: 'hi' }] },
    })
    expect(event).toMatchObject({
      type: 'user_message_reconciled',
      reconcile: { codexItemId: 'item-9', localImages: [], textElements: [] },
    })
    expect((event as { reconcile: { clientId?: string } }).reconcile.clientId).toBeUndefined()
  })

  it('tolerates snake_case variant tags and camelCase textElements from gateways', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/completed', {
      threadId: 't-1',
      turnId: 'u-1',
      item: {
        type: 'userMessage',
        id: 'item-9',
        clientId: 'msg-42',
        content: [
          {
            type: 'text',
            text: 'hi @bar',
            textElements: [{ byte_range: { start: 3, end: 7 }, placeholder: null }],
          },
          { type: 'local_image', path: '/tmp/b.png' },
        ],
      },
    })
    expect(event).toMatchObject({
      type: 'user_message_reconciled',
      reconcile: {
        localImages: ['/tmp/b.png'],
        textElements: [{ byteRange: { start: 3, end: 7 }, placeholder: null }],
      },
    })
  })

  it('drops malformed text_elements entries instead of crashing', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('item/completed', {
      threadId: 't-1',
      turnId: 'u-1',
      item: {
        type: 'userMessage',
        id: 'item-9',
        clientId: 'msg-42',
        content: [
          { type: 'text', text: 'hi', text_elements: [{ byteRange: 'nope' }, 42, null] },
          { type: 'localImage' },
        ],
      },
    })
    expect(event).toMatchObject({
      type: 'user_message_reconciled',
      reconcile: { localImages: [], textElements: [] },
    })
  })

  it('keeps dropping item/started userMessage (no duplicate bubble)', () => {
    const router = new CodexNotificationRouter()
    expect(
      router.route('item/started', {
        threadId: 't-1',
        turnId: 'u-1',
        item: { type: 'userMessage', id: 'item-9', content: [] },
      }),
    ).toBeNull()
  })
})
