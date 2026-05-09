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
      expect(event).toMatchObject({
        type: 'item_completed',
        itemId: 'fc-1',
        itemType: 'fileEdit',
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
  })

  describe('reasoning completion', () => {
    it('emits item_completed for reasoning items with no summary/content', () => {
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
        type: 'item_delta',
        threadId: 't',
        itemId: 'r-2',
        itemType: 'reasoning',
        patch: { kind: 'appendText', field: 'content', text: 'Plan: do A then B.' },
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
        payload: { kind: 'contextCompaction', label: 'compacting context', status: 'running' },
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

    it('forwards plan deltas onto the activity card detail slot', () => {
      const router = new CodexNotificationRouter()
      const event = router.route('item/plan/delta', {
        threadId: 't', turnId: 'u', itemId: 'plan-1', delta: '1. read file\n2. patch',
      })
      expect(event).toEqual({
        type: 'item_delta',
        threadId: 't',
        itemId: 'plan-1',
        itemType: 'activity',
        patch: { kind: 'mergeFields', fields: { detail: '1. read file\n2. patch' } },
      })
    })

    // Codex echoes the user's prompt back as an `item.type === 'userMessage'`
    // notification so it shows up in the canonical thread items[]. Our store
    // already pushed a local user bubble in `store.send()`, so showing the
    // echo as an "ACT userMessage" pill duplicates the message and looks
    // broken to the user. Drop it.
    it('drops userMessage echoes (item/started + item/completed) — already rendered locally', () => {
      const router = new CodexNotificationRouter()
      expect(
        router.route('item/started', {
          threadId: 't',
          turnId: 'u',
          item: { type: 'userMessage', id: 'um-1', text: 'hi' },
        }),
      ).toBeNull()
      expect(
        router.route('item/completed', {
          threadId: 't',
          turnId: 'u',
          item: { type: 'userMessage', id: 'um-1', text: 'hi' },
        }),
      ).toBeNull()
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
  })
})
