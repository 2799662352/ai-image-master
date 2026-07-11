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

  it('translates error notifications (terminal: willRetry false/absent)', () => {
    const router = new CodexNotificationRouter()
    expect(
      router.route('error', { threadId: 't', turnId: 'u', error: { message: 'boom' } }),
    ).toEqual({ type: 'error', threadId: 't', error: 'boom', willRetry: false })
    expect(
      router.route('error', { threadId: 't', turnId: 'u', error: { message: 'boom' }, willRetry: false }),
    ).toEqual({ type: 'error', threadId: 't', error: 'boom', willRetry: false })
  })

  it('forwards willRetry:true for stream-error notifications (openai/codex#7611)', () => {
    // codex-rs bespoke_event_handling.rs: EventMsg::StreamError → Error
    // notification with will_retry:true — the backend is about to re-stream
    // the same request with NEW item ids. Clients must not treat this as a
    // terminal error (VSCE renders it as "Reconnecting… 1/n").
    const router = new CodexNotificationRouter()
    expect(
      router.route('error', {
        threadId: 't',
        turnId: 'u',
        error: { message: 'stream disconnected before completion' },
        willRetry: true,
      }),
    ).toEqual({
      type: 'error',
      threadId: 't',
      error: 'stream disconnected before completion',
      willRetry: true,
    })
  })

  it('returns null for unrelated notifications', () => {
    const router = new CodexNotificationRouter()
    expect(router.route('thread/started', { threadId: 't' })).toBeNull()
    expect(router.route('thread/status/changed', { threadId: 't' })).toBeNull()
    expect(router.route('turn/started', { threadId: 't' })).toBeNull()
    // item/started without `type`+`id` is still a deliberate drop — we can't
    // build a card without at least an item id.
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

    it('emits item_delta for commandExecution stdout (legacy `output` method)', () => {
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

    // Regression: the canonical Codex protocol method is `outputDelta`, not
    // `output`. We were silently dropping every shell stream notification.
    it('emits item_delta for commandExecution stdout (canonical `outputDelta` method)', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/commandExecution/outputDelta', {
        threadId: 't',
        turnId: 'u',
        itemId: 'cmd-1',
        stream: 'stdout',
        data: 'hello\n',
      })
      expect(event).toEqual({
        type: 'item_delta',
        threadId: 't',
        itemId: 'cmd-1',
        itemType: 'shell',
        patch: { kind: 'appendText', field: 'stdout', text: 'hello\n' },
      })
    })

    it('emits item_delta for commandExecution stderr', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/commandExecution/outputDelta', {
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
      expect(event).toEqual({
        type: 'item_completed',
        threadId: 't',
        itemId: 'fc-1',
        itemType: 'fileEdit',
        final: {
          changes: [
            {
              path: 'src/foo.ts',
              operation: 'edit',
              diff: '@@ -1,1 +1,2 @@\n-old\n+new1\n+new2',
              added: 2,
              removed: 1,
            },
          ],
          totalAdded: 2,
          totalRemoved: 1,
        },
      })
    })
  })

  describe('CodexNotificationRouter file change diffs', () => {
    it('preserves file-change output deltas when completed changes omit unifiedDiff', () => {
      const router = new CodexNotificationRouter()

      expect(
        router.route('item/started', {
          threadId: 'thread-1',
          item: { id: 'file-1', type: 'fileChange' },
        }),
      ).toMatchObject({
        type: 'item_started',
        itemId: 'file-1',
        itemType: 'fileEdit',
      })

      expect(
        router.route('item/fileChange/outputDelta', {
          threadId: 'thread-1',
          itemId: 'file-1',
          delta: '@@\n-old\n+new\n',
        }),
      ).toBeNull()

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/a.ts', kind: 'edit' }],
          },
        }),
      ).toMatchObject({
        type: 'item_completed',
        itemId: 'file-1',
        itemType: 'fileEdit',
        final: {
          changes: [
            {
              path: 'src/a.ts',
              operation: 'edit',
              diff: '@@\n-old\n+new\n',
              added: 1,
              removed: 1,
            },
          ],
        },
      })
    })

    it('isolates streamed fallback diffs by item id', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        delta: '@@\n-old\n+new\n',
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-2',
            type: 'fileChange',
            changes: [{ path: 'src/b.ts', kind: 'edit' }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/b.ts',
              diff: '',
              added: 0,
              removed: 0,
            },
          ],
        },
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/a.ts', kind: 'edit' }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/a.ts',
              diff: '@@\n-old\n+new\n',
              added: 1,
              removed: 1,
            },
          ],
        },
      })
    })

    it('prefers structured completed unifiedDiff over streamed fallback text', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        delta: 'fallback text',
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/a.ts', kind: 'edit', unifiedDiff: '@@\n-a\n+b\n' }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/a.ts',
              diff: '@@\n-a\n+b\n',
              added: 1,
              removed: 1,
            },
          ],
        },
      })
    })

    it('preserves explicit empty completed unifiedDiff over streamed fallback text', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        delta: '@@\n-old\n+new\n',
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/a.ts', kind: 'edit', unifiedDiff: '' }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/a.ts',
              diff: '',
              added: 0,
              removed: 0,
            },
          ],
        },
      })
    })

    it('uses streamed fallback text when completed unifiedDiff is null', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        delta: '@@\n-old\n+new\n',
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/a.ts', kind: 'edit', unifiedDiff: null }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/a.ts',
              diff: '@@\n-old\n+new\n',
              added: 1,
              removed: 1,
            },
          ],
        },
      })
    })

    it('isolates streamed fallback diffs by thread and item id', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-a',
        itemId: 'file-1',
        delta: '@@\n-a\n+b\n',
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-b',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/b.ts', kind: 'edit' }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/b.ts',
              diff: '',
              added: 0,
              removed: 0,
            },
          ],
        },
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-a',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/a.ts', kind: 'edit' }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/a.ts',
              diff: '@@\n-a\n+b\n',
              added: 1,
              removed: 1,
            },
          ],
        },
      })
    })

    it('clears abandoned streamed fallback text when the thread turn completes', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        delta: '@@\n-old\n+new\n',
      })

      expect(
        router.route('turn/completed', {
          threadId: 'thread-1',
          turn: { id: 'turn-1' },
        }),
      ).toMatchObject({ type: 'turn_completed' })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/a.ts', kind: 'edit' }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/a.ts',
              diff: '',
              added: 0,
              removed: 0,
            },
          ],
        },
      })
    })

    it('does not attach streamed fallback diff to an arbitrary change when multiple changes are present', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        delta: '@@\n-old\n+new\n',
      })

      const event = router.route('item/completed', {
        threadId: 'thread-1',
        item: {
          id: 'file-1',
          type: 'fileChange',
          changes: [
            { path: 'src/a.ts', kind: 'edit' },
            { path: 'src/b.ts', kind: 'edit' },
          ],
        },
      })

      expect(event).toMatchObject({
        final: {
          changes: [
            { path: 'src/a.ts', diff: '', added: 0, removed: 0 },
            { path: 'src/b.ts', diff: '', added: 0, removed: 0 },
          ],
        },
      })
    })

    it('stores file-change output fallback text from params.data', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        data: '@@\n-old\n+new\n',
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/a.ts', kind: 'edit' }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/a.ts',
              diff: '@@\n-old\n+new\n',
              added: 1,
              removed: 1,
            },
          ],
        },
      })
    })

    it('creates a fallback file change from item.path when completed changes are missing', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        delta: '@@\n-old\n+new\n',
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
            path: 'src/fallback.ts',
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/fallback.ts',
              operation: 'edit',
              diff: '@@\n-old\n+new\n',
              added: 1,
              removed: 1,
            },
          ],
        },
      })
    })

    it('does not invent a file change when fallback text has no completed changes or item path', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        delta: '@@\n-old\n+new\n',
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
          },
        }),
      ).toMatchObject({
        final: {
          changes: [],
        },
      })
    })

    it('clears streamed fallback text after item/completed so it does not leak into later completions', () => {
      const router = new CodexNotificationRouter()

      router.route('item/fileChange/outputDelta', {
        threadId: 'thread-1',
        itemId: 'file-1',
        delta: '@@\n-old\n+new\n',
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/a.ts', kind: 'edit' }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/a.ts',
              diff: '@@\n-old\n+new\n',
              added: 1,
              removed: 1,
            },
          ],
        },
      })

      expect(
        router.route('item/completed', {
          threadId: 'thread-1',
          item: {
            id: 'file-1',
            type: 'fileChange',
            changes: [{ path: 'src/a.ts', kind: 'edit' }],
          },
        }),
      ).toMatchObject({
        final: {
          changes: [
            {
              path: 'src/a.ts',
              diff: '',
              added: 0,
              removed: 0,
            },
          ],
        },
      })
    })
  })

  describe('reasoning completion', () => {
    it('drops reasoning completions with no streamed deltas and no summary/content (no empty Thought pills)', () => {
      // Cumulative-snapshot gateways (apiyi, live 2026-06-10) emit one EMPTY
      // reasoning item per SSE chunk — 130 per reply. Since both event
      // consumers create-if-missing on item_completed, forwarding `final: {}`
      // would materialize an empty "Thought" pill per chunk. An empty
      // reasoning item carries zero information for ANY gateway → drop at
      // the source.
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'reasoning', id: 'r-1', summary: [], content: [] },
      })
      expect(event).toBeNull()
    })

    it('suppresses item_started for reasoning (seeded lazily by deltas / backfill)', () => {
      // Same rationale as agentMessage: in the snapshot pattern every chunk
      // opens a fresh empty reasoning item. Deltas and the text-bearing
      // completion backfill both create-if-missing downstream, so started
      // only ever materializes empty "Thought" pills.
      const router = new CodexNotificationRouter()
      const started = router.route('item/started', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'reasoning', id: 'r-1' },
      })
      expect(started).toBeNull()
    })

    it('still completes reasoning items whose deltas streamed', () => {
      const router = new CodexNotificationRouter()
      router.route('item/reasoning/textDelta', { threadId: 't', turnId: 'u', itemId: 'r-1', delta: 'thinking…' })
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

    // Regression for "思考过程没有成功展示出来": apiyi+gpt-5.x sometimes
    // omits `item/reasoning/*Delta` and only delivers the final reasoning
    // payload. Before the fix we'd render an empty "Thought" card; now we
    // backfill from the completed item's `summary`+`content` arrays.
    it('backfills reasoning text from final summary when no deltas streamed', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: {
          type: 'reasoning',
          id: 'r-2',
          summary: [{ type: 'summary_text', text: 'Plan: do A then B.' }],
          content: [],
        },
      })
      expect(event).toEqual({
        type: 'item_completed',
        threadId: 't',
        itemId: 'r-2',
        itemType: 'reasoning',
        final: { content: 'Plan: do A then B.' },
      })
    })

    it('skips reasoning backfill when deltas already streamed (avoids duplication)', () => {
      const router = new CodexNotificationRouter()
      router.route('item/reasoning/summaryTextDelta', {
        threadId: 't', turnId: 'u', itemId: 'r-3', delta: 'partial ',
      })
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: {
          type: 'reasoning',
          id: 'r-3',
          summary: [{ type: 'summary_text', text: 'partial then more' }],
          content: [],
        },
      })
      expect(event).toEqual({
        type: 'item_completed',
        threadId: 't',
        itemId: 'r-3',
        itemType: 'reasoning',
        final: {},
      })
    })

    it('scopes reasoning delta suppression by thread and item id', () => {
      const router = new CodexNotificationRouter()
      router.route('item/reasoning/summaryTextDelta', {
        threadId: 'thread-a', turnId: 'u', itemId: 'r-3', delta: 'partial ',
      })

      const event = router.route('item/completed', {
        threadId: 'thread-b',
        turnId: 'u',
        item: {
          type: 'reasoning',
          id: 'r-3',
          summary: [{ type: 'summary_text', text: 'thread b full reasoning' }],
          content: [],
        },
      })
      expect(event).toEqual({
        type: 'item_completed',
        threadId: 'thread-b',
        itemId: 'r-3',
        itemType: 'reasoning',
        final: { content: 'thread b full reasoning' },
      })
    })

    it('inserts a section break for summaryPartAdded', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/reasoning/summaryPartAdded', {
        threadId: 't', turnId: 'u', itemId: 'r-4',
      })
      expect(event).toEqual({
        type: 'item_delta',
        threadId: 't',
        itemId: 'r-4',
        itemType: 'reasoning',
        patch: { kind: 'appendText', field: 'content', text: '\n\n' },
      })
    })
  })

  // ---------------------------------------------------------------------
  // Cumulative-snapshot stream canonicalization ("对话重复" source fix).
  //
  // Wire-truth from the live repro (apiyi /v1/responses emulation,
  // 2026-06-10, DB row cmq7z96v60002ccn7zpsf7chw — 267 items): the gateway
  // does NOT stream `item/agentMessage/delta`. Instead every SSE chunk
  // arrives as a fresh pair of
  //   item/started  reasoning   (new rs_* id, never any text)
  //   item/completed reasoning  (empty)
  //   item/started  agentMessage (new msg_* id)
  //   item/completed agentMessage (text = FULL accumulated reply so far)
  // codex itself only speaks wire_api="responses" (chat was removed in
  // openai/codex#7782), so the only place we can normalize this is here —
  // the single ingestion point. Downstream dedup stays as a fallback.
  // ---------------------------------------------------------------------
  describe('cumulative-snapshot canonicalization (agentMessage)', () => {
    const T = 'thread-snap'

    function completeAgentMessage(router: CodexNotificationRouter, id: string, text: string) {
      router.route('item/started', { threadId: T, turnId: 'u', item: { type: 'agentMessage', id } })
      return router.route('item/completed', {
        threadId: T,
        turnId: 'u',
        item: { type: 'agentMessage', id, text },
      })
    }

    it('rewrites a growing full-text snapshot onto the FIRST item id as a suffix delta', () => {
      const router = new CodexNotificationRouter()
      const base = '我按原文的温柔、克制语气扩写了一版，保留核心意象，把情绪铺得更满。'

      const first = completeAgentMessage(router, 'msg-0', base.slice(0, 12))
      expect(first).toMatchObject({
        type: 'item_delta',
        itemId: 'msg-0',
        patch: { kind: 'appendText', field: 'content', text: base.slice(0, 12) },
      })

      // Snapshot 2: NEW id, full accumulated text → must target msg-0 with
      // only the new suffix, so downstream sees ONE growing item.
      const second = completeAgentMessage(router, 'msg-1', base.slice(0, 20))
      expect(second).toMatchObject({
        type: 'item_delta',
        itemId: 'msg-0',
        patch: { kind: 'appendText', field: 'content', text: base.slice(12, 20) },
      })

      const third = completeAgentMessage(router, 'msg-2', base)
      expect(third).toMatchObject({
        type: 'item_delta',
        itemId: 'msg-0',
        patch: { kind: 'appendText', field: 'content', text: base.slice(20) },
      })
    })

    it('emits a no-op suffix when an identical snapshot repeats under a new id', () => {
      const router = new CodexNotificationRouter()
      const text = '这一段足够长，可以触发快照折叠逻辑。'
      completeAgentMessage(router, 'msg-0', text)
      const dup = completeAgentMessage(router, 'msg-1', text)
      expect(dup).toMatchObject({
        type: 'item_delta',
        itemId: 'msg-0',
        patch: { kind: 'appendText', field: 'content', text: '' },
      })
    })

    it('treats non-extending text as a genuinely new paragraph (new canonical id)', () => {
      const router = new CodexNotificationRouter()
      completeAgentMessage(router, 'msg-0', '第一段：独立的分析内容，长度足够。')
      const next = completeAgentMessage(router, 'msg-1', '第二段：完全不同的结论，互不为前缀。')
      expect(next).toMatchObject({ type: 'item_delta', itemId: 'msg-1' })

      // …and the new paragraph becomes the canonical target for later snapshots.
      const grown = completeAgentMessage(router, 'msg-2', '第二段：完全不同的结论，互不为前缀。补充。')
      expect(grown).toMatchObject({
        type: 'item_delta',
        itemId: 'msg-1',
        patch: { kind: 'appendText', field: 'content', text: '补充。' },
      })
    })

    it('does not canonicalize across threads', () => {
      const router = new CodexNotificationRouter()
      const text = '同样的开头内容足够长足够长。'
      completeAgentMessage(router, 'msg-0', text)
      const other = router.route('item/completed', {
        threadId: 'other-thread',
        turnId: 'u',
        item: { type: 'agentMessage', id: 'msg-1', text: `${text}延伸` },
      })
      expect(other).toMatchObject({ type: 'item_delta', itemId: 'msg-1' })
    })

    it('skips canonicalization for short prefixes (below safety threshold)', () => {
      const router = new CodexNotificationRouter()
      completeAgentMessage(router, 'msg-0', '好的。')
      const next = completeAgentMessage(router, 'msg-1', '好的。我们继续推进下一步的修复工作。')
      expect(next).toMatchObject({ type: 'item_delta', itemId: 'msg-1' })
    })

    it('resets canonical tracking when the turn completes', () => {
      const router = new CodexNotificationRouter()
      const text = '本回合的完整回复，长度足够触发折叠。'
      completeAgentMessage(router, 'msg-0', text)
      router.route('turn/completed', { threadId: T, turn: { id: 'turn-1' } })

      // Next turn legitimately starts with the same opening — must NOT be
      // folded into the previous turn's item.
      const nextTurn = completeAgentMessage(router, 'msg-9', `${text}下一回合的延伸。`)
      expect(nextTurn).toMatchObject({ type: 'item_delta', itemId: 'msg-9' })
    })

    it('tracks content streamed via compliant agentMessage deltas too', () => {
      // Mixed-mode gateways: msg-0 streams real deltas, then a snapshot
      // arrives under a new id carrying the full text — still folded.
      const router = new CodexNotificationRouter()
      router.route('item/agentMessage/delta', { threadId: T, turnId: 'u', itemId: 'msg-0', delta: '前半段内容，' })
      router.route('item/agentMessage/delta', { threadId: T, turnId: 'u', itemId: 'msg-0', delta: '后半段内容。' })
      const snapshot = router.route('item/completed', {
        threadId: T,
        turnId: 'u',
        item: { type: 'agentMessage', id: 'msg-1', text: '前半段内容，后半段内容。结尾。' },
      })
      expect(snapshot).toMatchObject({
        type: 'item_delta',
        itemId: 'msg-0',
        patch: { kind: 'appendText', field: 'content', text: '结尾。' },
      })
    })

    it('suppresses item_started for agentMessage (items are seeded lazily by content events)', () => {
      // In the snapshot pattern item/started arrives with a brand-new id per
      // chunk; emitting item_started would materialize an empty text item
      // that the canonicalized delta then never touches. Both consumers
      // create-if-missing on item_delta, so started carries no information.
      const router = new CodexNotificationRouter()
      const started = router.route('item/started', {
        threadId: T,
        turnId: 'u',
        item: { type: 'agentMessage', id: 'msg-0' },
      })
      expect(started).toBeNull()
    })
  })

  // Regression for "工具调用信息 / mcp 调用信息 / 文档读取信息 没显示":
  // any item.type the router doesn't have a bespoke renderer for now goes
  // through the generic activity card instead of being silently dropped.
  describe('generic activity fallback (mcpToolCall, webSearch, contextCompaction, etc.)', () => {
    it('emits item_started as activity for mcpToolCall with server/tool/args summary', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 't',
        turnId: 'u',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-1',
          serverName: 'context7',
          toolName: 'docs.fetch',
          arguments: { query: 'react' },
          status: 'running',
        },
      })
      expect(event).toMatchObject({
        type: 'item_started',
        itemId: 'mcp-1',
        itemType: 'activity',
        payload: {
          kind: 'mcpToolCall',
          label: 'mcp:context7/docs.fetch',
          status: 'running',
        },
      })
      // Args should be JSON-stringified into the detail slot for visibility.
      expect((event as any).payload.detail).toContain('react')
    })

    it('emits item_started as activity for webSearch with query in detail', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'webSearch', id: 'ws-1', query: 'codex protocol notifications' },
      })
      expect(event).toMatchObject({
        type: 'item_started',
        itemId: 'ws-1',
        itemType: 'activity',
        payload: {
          kind: 'webSearch',
          label: 'web search',
          detail: 'codex protocol notifications',
        },
      })
    })

    it('emits item_started as activity for contextCompaction (covers "上下文压缩进度")', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'contextCompaction', id: 'cc-1' },
      })
      expect(event).toMatchObject({
        type: 'item_started',
        itemId: 'cc-1',
        itemType: 'activity',
        payload: { kind: 'contextCompaction', label: '压缩上下文', status: 'running' },
      })
    })

    it('emits item_completed as activity with success status when no error', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'mcpToolCall', id: 'mcp-1', serverName: 'context7', toolName: 'docs.fetch' },
      })
      expect(event).toMatchObject({
        type: 'item_completed',
        itemId: 'mcp-1',
        itemType: 'activity',
        final: { kind: 'mcpToolCall', status: 'success' },
      })
    })

    it('emits item_completed as activity with error status when item.error is set', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-2',
          serverName: 'fs',
          toolName: 'read',
          error: 'EACCES',
        },
      })
      expect(event).toMatchObject({
        type: 'item_completed',
        itemId: 'mcp-2',
        itemType: 'activity',
        final: { kind: 'mcpToolCall', status: 'error', error: 'EACCES' },
      })
    })

    it('drops PlanDeltaNotification (item/plan/delta) — text deltas have no PlanCard correspondence', () => {
      // The plan ThreadItem's text field is a pre-rendered blob; its streaming
      // deltas (PlanDeltaNotification) are flagged EXPERIMENTAL in the schema:
      // "Clients should not assume concatenated deltas match the completed
      // plan item content." We render the structured plan from the dedicated
      // `turn/plan/updated` channel instead, so this stream is dropped.
      const router = new CodexNotificationRouter()
      expect(
        router.route('item/plan/delta', {
          threadId: 't', turnId: 'u', itemId: 'plan-1', delta: '1. read file\n2. patch',
        }),
      ).toBeNull()
    })

    // Codex echoes the user's prompt back as an `item.type === 'userMessage'`
    // notification so it shows up in the canonical thread items[]. Our store
    // already pushed a local user bubble in `store.send()`, so it must never
    // render as a visible "ACT userMessage" pill. `item/started` stays dropped;
    // `item/completed` is now routed into the INTERNAL `user_message_reconciled`
    // event (consumed by AgentManager for DB reconciliation, never forwarded to
    // the renderer — see codexNotificationRouter.userMessage.test.ts).
    it('userMessage echoes: started dropped, completed becomes internal reconcile event (never a visible item)', () => {
      const router = new CodexNotificationRouter()
      expect(
        router.route('item/started', {
          threadId: 't',
          turnId: 'u',
          item: { type: 'userMessage', id: 'um-1', text: 'hi' },
        }),
      ).toBeNull()
      const completed = router.route('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: { type: 'userMessage', id: 'um-1', text: 'hi' },
      })
      expect(completed?.type).toBe('user_message_reconciled')
    })
  })

  describe('thread/settings/updated', () => {
    it('emits the confirmed thread settings as an internal event', () => {
      const router = new CodexNotificationRouter()
      expect(
        router.route('thread/settings/updated', {
          threadId: 'codex-thread-1',
          threadSettings: {
            model: 'gpt-5.5',
            effort: 'high',
            collaborationMode: {
              mode: 'default',
              settings: {
                model: 'gpt-5.5',
                reasoning_effort: 'high',
                developer_instructions: null,
              },
            },
          },
        }),
      ).toEqual({
        type: 'thread_settings_updated',
        threadId: 'codex-thread-1',
        mode: 'default',
        model: 'gpt-5.5',
        effort: 'high',
      })
    })

    it.each([
      ['empty threadId', { threadId: '', threadSettings: { model: 'gpt-5.5', collaborationMode: { mode: 'default' } } }],
      ['missing threadSettings', { threadId: 'codex-thread-1' }],
      ['array threadSettings', { threadId: 'codex-thread-1', threadSettings: [] }],
      ['missing collaborationMode', { threadId: 'codex-thread-1', threadSettings: { model: 'gpt-5.5' } }],
      ['array collaborationMode', { threadId: 'codex-thread-1', threadSettings: { model: 'gpt-5.5', collaborationMode: [] } }],
      ['invalid mode', { threadId: 'codex-thread-1', threadSettings: { model: 'gpt-5.5', collaborationMode: { mode: 'review' } } }],
      ['empty model', { threadId: 'codex-thread-1', threadSettings: { model: '', collaborationMode: { mode: 'plan' } } }],
    ])('returns null for malformed payload: %s', (_label, params) => {
      const router = new CodexNotificationRouter()
      expect(router.route('thread/settings/updated', params)).toBeNull()
    })
  })

  describe('thread/tokenUsage/updated', () => {
    it('emits token_usage_updated with input/output tokens', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        turnId: 'u',
        usage: { inputTokens: 1234, outputTokens: 567, reasoningTokens: 100, cachedInputTokens: 200 },
        contextWindow: 200_000,
        contextUsage: 5000,
      })
      expect(event).toEqual({
        type: 'token_usage_updated',
        threadId: 't',
        turnId: 'u',
        usage: {
          inputTokens: 1234,
          outputTokens: 567,
          reasoningTokens: 100,
          cachedInputTokens: 200,
          contextWindow: 200_000,
          contextUsage: 5000,
        },
      })
    })

    it('accepts snake_case shape from gateways', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50 },
      })
      expect(event).toMatchObject({
        type: 'token_usage_updated',
        usage: { inputTokens: 100, outputTokens: 200, cachedInputTokens: 50 },
      })
    })

    it('returns null when payload carries no usable counter', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        usage: {},
      })
      expect(event).toBeNull()
    })

    // Captured directly from the codex 0.128 trace log line:
    //   [codex trace] thread/tokenUsage/updated#... {"tokenUsage":{
    //     "total":{"totalTokens":12816,"inputTokens":12508,"cachedInputTokens":0,
    //              "outputTokens":308,"reasoningOutputTokens":256},
    //     "last":{...}}}
    // Pre-fix our extractor bound `u = params.tokenUsage` and looked for
    // `u.inputTokens` (flat) — which doesn't exist in this shape, so we
    // returned null and the TokenUsageMeter donut never lit up.
    it('extracts cumulative usage from the nested tokenUsage.total shape (codex 0.128)', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        turnId: 'u',
        tokenUsage: {
          total: {
            totalTokens: 12816,
            inputTokens: 12508,
            cachedInputTokens: 0,
            outputTokens: 308,
            reasoningOutputTokens: 256,
          },
          last: {
            inputTokens: 200,
            outputTokens: 50,
          },
        },
      })
      // `toMatchObject` instead of `toEqual` because Task A added the
      // `usage.last` field — the cumulative-extraction test doesn't care about
      // `last` (a separate test asserts that), but `toEqual` would now fail
      // due to the extra property.
      expect(event).toMatchObject({
        type: 'token_usage_updated',
        threadId: 't',
        turnId: 'u',
        usage: {
          inputTokens: 12508,
          outputTokens: 308,
          reasoningTokens: 256,
          cachedInputTokens: 0,
        },
      })
    })

    it('falls back to tokenUsage.last when total is missing', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        tokenUsage: {
          last: { inputTokens: 100, outputTokens: 50 },
        },
      })
      expect(event).toMatchObject({
        type: 'token_usage_updated',
        usage: { inputTokens: 100, outputTokens: 50 },
      })
    })

    it('captures tokenUsage.last as usage.last when both are present', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        turnId: 'u',
        tokenUsage: {
          total: { inputTokens: 12508, outputTokens: 308, cachedInputTokens: 8000, reasoningOutputTokens: 256 },
          last: { inputTokens: 200, outputTokens: 50, reasoningOutputTokens: 30, cachedInputTokens: 100 },
        },
      })
      expect(event).toMatchObject({
        type: 'token_usage_updated',
        usage: {
          inputTokens: 12508,
          last: {
            inputTokens: 200,
            outputTokens: 50,
            reasoningTokens: 30,
            cachedInputTokens: 100,
          },
        },
      })
    })

    it('omits usage.last when tokenUsage.last is missing', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        tokenUsage: { total: { inputTokens: 100, outputTokens: 50 } },
      })
      expect(event).toMatchObject({ type: 'token_usage_updated' })
      expect((event as { usage: { last?: unknown } }).usage.last).toBeUndefined()
    })

    it('omits usage.last when tokenUsage.last has all-zero input/output (no signal)', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        tokenUsage: {
          total: { inputTokens: 100, outputTokens: 50 },
          last: { inputTokens: 0, outputTokens: 0 },
        },
      })
      expect((event as { usage: { last?: unknown } }).usage.last).toBeUndefined()
    })

    it('handles snake_case aliases inside tokenUsage.last', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        tokenUsage: {
          total: { inputTokens: 1000, outputTokens: 500 },
          last: { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 40 },
        },
      })
      expect(event).toMatchObject({
        type: 'token_usage_updated',
        usage: { last: { inputTokens: 80, outputTokens: 30, cachedInputTokens: 40 } },
      })
    })

    // Regression for the "meter stuck at 100% + no compaction shown" bug.
    // codex-core's `total` SUMS every request's full prompt across the whole
    // thread, so on a long thread it dwarfs the context window. The context
    // meter must instead reflect the LAST request's absolute size (current
    // occupancy). We synthesize `contextUsage` from `last` so the donut +
    // watermark divide the RIGHT numerator by the window.
    it('synthesizes contextUsage from last (current occupancy), not cumulative total', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        turnId: 'u',
        contextWindow: 272_000,
        tokenUsage: {
          // Cumulative would be 268k → 98% of the window (false near-full).
          total: { inputTokens: 250_000, outputTokens: 18_000 },
          // Real current context is only ~40k → 15%.
          last: { inputTokens: 38_000, outputTokens: 2_000 },
        },
      })
      expect(event).toMatchObject({
        type: 'token_usage_updated',
        usage: { contextUsage: 40_000, contextWindow: 272_000 },
      })
    })

    it('keeps an explicit gateway contextUsage over the last-derived value', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        contextUsage: 12_345,
        tokenUsage: {
          total: { inputTokens: 250_000, outputTokens: 18_000 },
          last: { inputTokens: 38_000, outputTokens: 2_000 },
        },
      })
      expect((event as { usage: { contextUsage?: number } }).usage.contextUsage).toBe(12_345)
    })

    it('leaves contextUsage undefined when there is no last slice (cumulative-only gateway)', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('thread/tokenUsage/updated', {
        threadId: 't',
        tokenUsage: { total: { inputTokens: 100, outputTokens: 50 } },
      })
      expect((event as { usage: { contextUsage?: number } }).usage.contextUsage).toBeUndefined()
    })
  })

  describe('plan steps (turn/plan/updated)', () => {
    // Codex's `update_plan` / `todo_write` tool emits structured plan data via
    // the `turn/plan/updated` notification (PR openai/codex#7329). The plan
    // ThreadItem only carries a pre-rendered text blob in v2, so we route the
    // structured plan exclusively through this dedicated channel.

    it('synthesizes a plan ActivityItem keyed by `plan:${turnId}` with normalized steps', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('turn/plan/updated', {
        threadId: 't',
        turnId: 'turn-9',
        explanation: null,
        plan: [
          { step: 'Read source', status: 'completed' },
          { step: 'Write fix', status: 'in_progress' },
          { step: 'Run tests', status: 'pending' },
        ],
      })
      expect(event).toEqual({
        type: 'item_delta',
        threadId: 't',
        turnId: 'turn-9',
        itemId: 'plan:turn-9',
        itemType: 'activity',
        patch: {
          kind: 'mergeFields',
          fields: {
            kind: 'plan',
            label: 'plan',
            steps: [
              { text: 'Read source', status: 'completed' },
              { text: 'Write fix', status: 'in_progress' },
              { text: 'Run tests', status: 'pending' },
            ],
            status: 'running',
          },
        },
      })
    })

    it('flips status to success when every step is completed', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('turn/plan/updated', {
        threadId: 't',
        turnId: 'turn-9',
        plan: [
          { step: 'A', status: 'completed' },
          { step: 'B', status: 'completed' },
        ],
      })
      expect(event).toMatchObject({
        patch: { fields: { status: 'success' } },
      })
    })

    it('surfaces explanation as the card detail when present', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('turn/plan/updated', {
        threadId: 't',
        turnId: 'turn-9',
        explanation: 'Refactoring db.ts before touching call sites',
        plan: [{ step: 'A', status: 'pending' }],
      })
      expect(event).toMatchObject({
        patch: { fields: { detail: 'Refactoring db.ts before touching call sites' } },
      })
    })

    it('accepts `text` as a fallback for `step` (older / experimental gateways)', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('turn/plan/updated', {
        threadId: 't',
        turnId: 'turn-9',
        plan: [{ text: 'A', status: 'completed' }],
      })
      expect(event).toMatchObject({
        patch: { fields: { steps: [{ text: 'A', status: 'completed' }] } },
      })
    })

    it('falls back to pending for non-canonical statuses and drops invalid entries', () => {
      // Codex's protocol only emits the three canonical statuses
      // (`pending` / `in_progress` / `completed`). Anything else is gateway
      // garbage — we keep the entry but show it as pending so the user still
      // sees the step text.
      const router = new CodexNotificationRouter()
      const event = router.route('turn/plan/updated', {
        threadId: 't',
        turnId: 'turn-9',
        plan: [
          { step: 'good', status: 'wat' },
          null,
          { step: 'no-status' },
          { status: 'completed' }, // missing text → dropped
        ],
      })
      const fields = (event as unknown as { patch: { fields: { steps: unknown } } }).patch.fields
      expect(fields.steps).toEqual([
        { text: 'good', status: 'pending' },
        { text: 'no-status', status: 'pending' },
      ])
    })

    it('returns null when turnId is missing (we need it for the synthetic itemId)', () => {
      const router = new CodexNotificationRouter()
      expect(
        router.route('turn/plan/updated', {
          threadId: 't',
          plan: [{ step: 'A', status: 'pending' }],
        }),
      ).toBeNull()
    })

    it('returns null when plan[] is empty / missing — no card to render', () => {
      const router = new CodexNotificationRouter()
      expect(
        router.route('turn/plan/updated', { threadId: 't', turnId: 'u', plan: [] }),
      ).toBeNull()
      expect(
        router.route('turn/plan/updated', { threadId: 't', turnId: 'u' }),
      ).toBeNull()
    })

    it('drops `item/started` and `item/completed` for `type: "plan"` to avoid duplicating the PlanCard', () => {
      // The plan ThreadItem (`{ type: 'plan', id, text }`) carries only a
      // pre-rendered text blob in v2. Routing it through the generic activity
      // pill would create a second card next to the structured PlanCard built
      // from `turn/plan/updated`, confusing the user.
      const router = new CodexNotificationRouter()
      expect(
        router.route('item/started', {
          threadId: 't',
          turnId: 'u',
          item: { type: 'plan', id: 'plan-1', text: '' },
        }),
      ).toBeNull()
      expect(
        router.route('item/completed', {
          threadId: 't',
          turnId: 'u',
          item: { type: 'plan', id: 'plan-1', text: '1. A\n2. B' },
        }),
      ).toBeNull()
    })
  })

  // ---------------------------------------------------------------------
  // Plan steps via dynamicToolCall (the actual wire shape Codex 0.130.0
  // uses against non-Responses-API gateways — `update_plan` / `todo_write`
  // arrives as a regular function tool call with the structured plan tucked
  // inside `item.arguments.plan`, instead of the dedicated
  // `turn/plan/updated` notification). Without these intercepts the user
  // sees a generic "TOOL plan running" chip and nothing else; the
  // structured steps are silently dropped.
  // ---------------------------------------------------------------------
  describe('plan steps (dynamicToolCall fallback)', () => {
    const baseArgs = {
      plan: [
        { step: 'Phase 1: investigate', status: 'in_progress' },
        { step: 'Phase 2: patch', status: 'pending' },
      ],
      explanation: 'Two-phase fix',
    }

    it('routes `item/started` with toolName=update_plan to the synthetic plan item', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'tool-1',
          toolName: 'update_plan',
          arguments: baseArgs,
        },
      })
      expect(event).toEqual({
        type: 'item_delta',
        threadId: 'thr',
        turnId: 'tur',
        itemId: 'plan:tur',
        itemType: 'activity',
        patch: {
          kind: 'mergeFields',
          fields: {
            kind: 'plan',
            label: 'plan',
            steps: [
              { text: 'Phase 1: investigate', status: 'in_progress' },
              { text: 'Phase 2: patch', status: 'pending' },
            ],
            status: 'running',
            detail: 'Two-phase fix',
          },
        },
      })
    })

    it('also detects the short alias `plan` and the rename target `todo_write`', () => {
      const router = new CodexNotificationRouter()
      for (const toolName of ['plan', 'todo_write', 'PLAN', 'Todo_Write']) {
        const event = router.route('item/started', {
          threadId: 'thr',
          turnId: 'tur',
          item: {
            type: 'dynamicToolCall',
            id: `tool-${toolName}`,
            toolName,
            arguments: baseArgs,
          },
        })
        expect(event).not.toBeNull()
        expect(event).toMatchObject({
          itemId: 'plan:tur',
          patch: { kind: 'mergeFields', fields: { kind: 'plan' } },
        })
      }
    })

    it('reads the toolName from `tool` or `name` when `toolName` is absent (v2 schema / MCP shape)', () => {
      const router = new CodexNotificationRouter()
      const viaTool = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: { type: 'dynamicToolCall', id: 'tc-1', tool: 'update_plan', arguments: baseArgs },
      })
      expect(viaTool).toMatchObject({ itemId: 'plan:tur' })
      const viaName = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: { type: 'dynamicToolCall', id: 'tc-2', name: 'plan', arguments: baseArgs },
      })
      expect(viaName).toMatchObject({ itemId: 'plan:tur' })
    })

    it('parses arguments delivered as a JSON string (Responses-API function-call shape)', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'tool-str',
          toolName: 'update_plan',
          arguments: JSON.stringify(baseArgs),
        },
      })
      expect(event).toMatchObject({
        itemId: 'plan:tur',
        patch: {
          fields: {
            kind: 'plan',
            steps: [
              { text: 'Phase 1: investigate', status: 'in_progress' },
              { text: 'Phase 2: patch', status: 'pending' },
            ],
          },
        },
      })
    })

    it('keeps status=running on intermediate `item/completed` when the snapshot still has pending/in_progress steps', () => {
      // Codex calls `update_plan` repeatedly during a turn (once per step
      // transition). Each individual tool call completes in milliseconds.
      // We must NOT flip the card to success on every tool-call completion
      // or the PlanCard would flash green between calls.
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'tool-mid',
          toolName: 'update_plan',
          arguments: baseArgs, // first step in_progress, second pending
        },
      })
      expect(event).toMatchObject({
        type: 'item_delta',
        itemId: 'plan:tur',
        patch: { kind: 'mergeFields', fields: { status: 'running' } },
      })
    })

    it('flips status to success on the final `item/completed` when every step is completed', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/completed', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'tool-final',
          toolName: 'update_plan',
          arguments: {
            plan: [
              { step: 'Phase 1: investigate', status: 'completed' },
              { step: 'Phase 2: patch', status: 'completed' },
            ],
            explanation: 'Done',
          },
        },
      })
      expect(event).toMatchObject({
        type: 'item_delta',
        itemId: 'plan:tur',
        patch: { kind: 'mergeFields', fields: { status: 'success' } },
      })
    })

    it('upserts in-place across successive update_plan tool calls (single PlanCard, progressive status)', () => {
      // Integration test for the "todolist marches forward" UX: three
      // successive `update_plan` tool calls in the same turn should produce
      // events that all target `plan:${turnId}`, so the renderer's
      // `upsertItemInLastMessage` merges them into one card whose steps
      // progress pending → in_progress → completed in place.
      const router = new CodexNotificationRouter()
      const turnId = 'tur'
      const ev1 = router.route('item/started', {
        threadId: 'thr',
        turnId,
        item: {
          type: 'dynamicToolCall',
          id: 'call-1',
          toolName: 'update_plan',
          arguments: {
            plan: [
              { step: 'A', status: 'in_progress' },
              { step: 'B', status: 'pending' },
              { step: 'C', status: 'pending' },
            ],
          },
        },
      })
      const ev2 = router.route('item/started', {
        threadId: 'thr',
        turnId,
        item: {
          type: 'dynamicToolCall',
          id: 'call-2',
          toolName: 'update_plan',
          arguments: {
            plan: [
              { step: 'A', status: 'completed' },
              { step: 'B', status: 'in_progress' },
              { step: 'C', status: 'pending' },
            ],
          },
        },
      })
      const ev3 = router.route('item/completed', {
        threadId: 'thr',
        turnId,
        item: {
          type: 'dynamicToolCall',
          id: 'call-3',
          toolName: 'update_plan',
          arguments: {
            plan: [
              { step: 'A', status: 'completed' },
              { step: 'B', status: 'completed' },
              { step: 'C', status: 'completed' },
            ],
          },
        },
      })
      // All three events target the same synthetic id → same PlanCard.
      expect(ev1).toMatchObject({ itemId: `plan:${turnId}` })
      expect(ev2).toMatchObject({ itemId: `plan:${turnId}` })
      expect(ev3).toMatchObject({ itemId: `plan:${turnId}` })
      // Status flips only on the final call (all completed).
      expect((ev1 as any).patch.fields.status).toBe('running')
      expect((ev2 as any).patch.fields.status).toBe('running')
      expect((ev3 as any).patch.fields.status).toBe('success')
    })

    it('also works for `collabToolCall` (Codex collab agent dispatch)', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'collabToolCall',
          id: 'collab-1',
          toolName: 'plan',
          arguments: baseArgs,
        },
      })
      expect(event).toMatchObject({
        itemId: 'plan:tur',
        patch: { fields: { kind: 'plan' } },
      })
    })

    it('falls through to the generic dynamicToolCall chip for non-plan tools', () => {
      // Sanity check: arbitrary function tool calls still get the generic
      // activity card so we don't accidentally swallow them.
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'tool-search',
          toolName: 'web_search',
          arguments: { query: 'foo' },
        },
      })
      expect(event).toMatchObject({
        type: 'item_started',
        itemType: 'activity',
        payload: { kind: 'dynamicToolCall', label: 'web_search' },
      })
    })

    // ---------------------------------------------------------------------
    // Wire-truth regressions: Codex 0.130.0 ships a `TurnPlanStepStatus`
    // enum with `#[serde(rename_all = "camelCase")]` for the
    // `turn/plan/updated` notification, AND a separate `StepStatus` enum
    // with `#[serde(rename_all = "snake_case")]` for the `update_plan`
    // tool arguments. Earlier router builds only accepted snake_case so
    // every `inProgress` step from `turn/plan/updated` silently downgraded
    // to `pending`, making the PlanCard render look frozen.
    //   - codex-rs/app-server-protocol/src/protocol/v2.rs (camelCase)
    //   - codex-rs/protocol/src/plan_tool.rs (snake_case)
    // ---------------------------------------------------------------------
    it('accepts camelCase `inProgress` status from the v2 turn/plan/updated channel', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('turn/plan/updated', {
        threadId: 't',
        turnId: 'u',
        plan: [
          { step: 'A', status: 'completed' },
          { step: 'B', status: 'inProgress' }, // ← v2 camelCase
          { step: 'C', status: 'pending' },
        ],
      })
      expect((event as any).patch.fields.steps).toEqual([
        { text: 'A', status: 'completed' },
        { text: 'B', status: 'in_progress' }, // ← normalised to snake_case
        { text: 'C', status: 'pending' },
      ])
    })

    it('also tolerates kebab-case, PascalCase and synonyms (gateway rewrites in the wild)', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('turn/plan/updated', {
        threadId: 't',
        turnId: 'u',
        plan: [
          { step: 'kebab', status: 'in-progress' },
          { step: 'pascal', status: 'InProgress' },
          { step: 'screaming', status: 'IN_PROGRESS' },
          { step: 'synonym-active', status: 'active' },
          { step: 'synonym-running', status: 'running' },
          { step: 'done-alias', status: 'done' },
        ],
      })
      expect((event as any).patch.fields.steps).toEqual([
        { text: 'kebab', status: 'in_progress' },
        { text: 'pascal', status: 'in_progress' },
        { text: 'screaming', status: 'in_progress' },
        { text: 'synonym-active', status: 'in_progress' },
        { text: 'synonym-running', status: 'in_progress' },
        { text: 'done-alias', status: 'completed' },
      ])
    })

    it('reads dynamicToolCall.tool (v2 canonical), not just .toolName / .name', () => {
      // v2 ThreadItem schema names the field `tool: String` — earlier router
      // builds only read `toolName` / `name`, so on Codex 0.130.0 the plan
      // tool would never be recognised and we'd fall through to a useless
      // generic chip labelled `'tool'`.
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'call-canonical',
          // No `toolName`, no `name` — only the v2 canonical `tool` field.
          tool: 'update_plan',
          arguments: {
            plan: [{ step: 'step', status: 'in_progress' }],
          },
        },
      })
      expect(event).toMatchObject({
        itemId: 'plan:tur',
        patch: {
          kind: 'mergeFields',
          fields: {
            kind: 'plan',
            steps: [{ text: 'step', status: 'in_progress' }],
          },
        },
      })
    })

    it('still emits a plan placeholder card when args have no plan shape (image-2 wire case)', () => {
      // The user's gateway sometimes invokes the `plan` tool with no
      // structured payload — args either missing, a freeform string, or
      // an unrelated object. Earlier behaviour fell through to a generic
      // "TOOL plan running" chip + EvidenceDetails dump, which the user
      // explicitly called out as wrong UX. The card should *always*
      // reserve a slot when the plan tool fires; PlanCard renders a
      // "Creating plan…" placeholder when steps[] is empty.
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'tool-empty',
          toolName: 'plan',
          arguments: { unrelated: 'data' },
        },
      })
      expect(event).toMatchObject({
        type: 'item_delta',
        itemId: 'plan:tur',
        itemType: 'activity',
        patch: {
          kind: 'mergeFields',
          fields: {
            kind: 'plan',
            steps: [],
            status: 'running',
          },
        },
      })
    })

    it('extracts a plan from `args.todo` singular (Codex PR #10124 future-proof path)', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'todo-1',
          tool: 'todo_write',
          arguments: {
            todo: [
              { step: 'first', status: 'in_progress' },
              { step: 'second', status: 'pending' },
            ],
          },
        },
      })
      expect((event as any).patch.fields.steps).toEqual([
        { text: 'first', status: 'in_progress' },
        { text: 'second', status: 'pending' },
      ])
    })

    it('falls back to freeform-string extraction when args are a markdown prose plan', () => {
      // Many Chinese gateways front of OpenAI-compat APIs forward
      // function-call arguments as a raw markdown string instead of a
      // structured JSON object. Without this fallback the PlanCard sits
      // empty even though the model clearly *did* write a plan.
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'prose-1',
          tool: 'plan',
          arguments:
            '这是一个用于展示 todo list 的小计划。\n' +
            '1. 确认展示格式\n' +
            '2. 列出简单任务\n' +
            '3. 根据反馈调整\n' +
            '当前第 2 项是进行中状态。',
        },
      })
      expect((event as any).patch.fields.steps).toEqual([
        { text: '确认展示格式', status: 'pending' },
        { text: '列出简单任务', status: 'in_progress' },
        { text: '根据反馈调整', status: 'pending' },
      ])
    })

    it('parses freeform plan from args.explanation when no structured plan field', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'expl-1',
          tool: 'update_plan',
          arguments: {
            explanation: '- 第一步\n- 第二步\n- 第三步',
          },
        },
      })
      expect((event as any).patch.fields.steps).toEqual([
        { text: '第一步', status: 'pending' },
        { text: '第二步', status: 'pending' },
        { text: '第三步', status: 'pending' },
      ])
    })

    it('honours explicit checkbox / glyph status markers in freeform prose', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/started', {
        threadId: 'thr',
        turnId: 'tur',
        item: {
          type: 'dynamicToolCall',
          id: 'mixed-1',
          tool: 'plan',
          arguments:
            '1. [x] step one done\n' +
            '2. [-] step two in progress\n' +
            '3. [ ] step three not started',
        },
      })
      expect((event as any).patch.fields.steps).toEqual([
        { text: 'step one done', status: 'completed' },
        { text: 'step two in progress', status: 'in_progress' },
        { text: 'step three not started', status: 'pending' },
      ])
    })
  })

  // ---------------------------------------------------------------------
  // Codex app-server protocol notifications we should pass through to the
  // renderer rather than silently drop. References:
  //   - codex-rs/app-server/README.md (notifications section)
  //   - codex-rs/app-server-protocol/src/protocol.rs
  // ---------------------------------------------------------------------
  describe('extra protocol notifications (skills, hooks, deprecation, etc.)', () => {
    it('routes skills/changed to a `skills_changed` stream event (no payload)', () => {
      const router = new CodexNotificationRouter()
      expect(router.route('skills/changed', {})).toEqual({ type: 'skills_changed' })
    })

    it('routes configWarning to a warning notice', () => {
      const router = new CodexNotificationRouter()
      const ev = router.route('configWarning', { message: 'missing key model_provider' })
      expect(ev).toMatchObject({
        type: 'notice',
        notice: { kind: 'configWarning', level: 'warning', message: 'missing key model_provider' },
      })
    })

    it('routes deprecationNotice to a warning notice', () => {
      const router = new CodexNotificationRouter()
      const ev = router.route('deprecationNotice', { message: 'custom_prompts has been removed' })
      expect(ev).toMatchObject({
        type: 'notice',
        notice: { kind: 'deprecation', level: 'warning', message: 'custom_prompts has been removed' },
      })
    })

    it('routes model/rerouted with from/to in details', () => {
      const router = new CodexNotificationRouter()
      const ev = router.route('model/rerouted', { from: 'gpt-5', to: 'gpt-4-turbo', reason: 'rate-limit' })
      expect(ev).toMatchObject({
        type: 'notice',
        notice: { kind: 'modelRerouted', level: 'info', details: { from: 'gpt-5', to: 'gpt-4-turbo', reason: 'rate-limit' } },
      })
      // Surface a humane message that the chat banner can display directly.
      expect((ev as { notice: { message: string } }).notice.message).toContain('gpt-5')
      expect((ev as { notice: { message: string } }).notice.message).toContain('gpt-4-turbo')
    })

    it('routes hook/started and hook/completed as info notices', () => {
      const router = new CodexNotificationRouter()
      const started = router.route('hook/started', { hookName: 'pre-commit', threadId: 't' })
      expect(started).toMatchObject({
        type: 'notice',
        notice: { kind: 'hookStarted', level: 'info', threadId: 't', message: expect.stringContaining('pre-commit') },
      })
      const completed = router.route('hook/completed', { hookName: 'pre-commit', threadId: 't', success: true })
      expect(completed).toMatchObject({
        type: 'notice',
        notice: { kind: 'hookCompleted', level: 'info', threadId: 't' },
      })
    })

    it('routes item/autoApprovalReview/started and /completed as info notices', () => {
      const router = new CodexNotificationRouter()
      const start = router.route('item/autoApprovalReview/started', {
        threadId: 't',
        itemId: 'shell-1',
      })
      expect(start).toMatchObject({
        type: 'notice',
        notice: { kind: 'autoApprovalReview', level: 'info', threadId: 't' },
      })
      const done = router.route('item/autoApprovalReview/completed', {
        threadId: 't',
        itemId: 'shell-1',
        approved: true,
      })
      expect(done).toMatchObject({
        type: 'notice',
        notice: { kind: 'autoApprovalReviewCompleted', level: 'info', threadId: 't' },
      })
    })

    it('returns null for unknown methods (default case)', () => {
      const router = new CodexNotificationRouter()
      expect(router.route('totally/unknown/method', {})).toBeNull()
    })
  })
})
