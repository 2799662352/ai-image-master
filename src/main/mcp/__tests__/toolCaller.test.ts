// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  callerCodexThreadIds,
  currentToolCaller,
  extractCodexCaller,
  mergeToolCaller,
  runWithToolCaller,
} from '../toolCaller'
import { withToolCallerScope } from '../tools'

/**
 * `_meta` shapes below are the ones the bundled codex 0.169.0 actually sends,
 * captured with `scripts/smoke-mcp-thread-meta.ts`. They are the contract the
 * whole attribution chain stands on, so they are written out literally.
 */
const ctx = (meta: unknown): unknown => ({ mcpReq: { _meta: meta } })

const PLAIN = ctx({
  threadId: 'T-plain',
  sessionId: 'T-plain',
  'x-codex-turn-metadata': { thread_id: 'T-plain', session_id: 'T-plain', turn_id: 'turn-1' },
})

const FORK = ctx({
  threadId: 'T-fork',
  sessionId: 'T-fork',
  'x-codex-turn-metadata': {
    thread_id: 'T-fork',
    session_id: 'T-fork',
    forked_from_thread_id: 'T-source',
  },
})

const SUBAGENT = ctx({
  threadId: 'T-child',
  sessionId: 'T-parent',
  'x-codex-turn-metadata': {
    thread_id: 'T-child',
    session_id: 'T-parent',
    parent_thread_id: 'T-parent',
    forked_from_thread_id: 'T-parent',
  },
})

const NESTED_SUBAGENT = ctx({
  threadId: 'T-grandchild',
  sessionId: 'T-root',
  'x-codex-turn-metadata': {
    thread_id: 'T-grandchild',
    session_id: 'T-root',
    parent_thread_id: 'T-child',
  },
})

describe('extractCodexCaller', () => {
  it('an ordinary conversation thread has no ancestors', () => {
    expect(extractCodexCaller(PLAIN)).toEqual({ threadId: 'T-plain', ancestorThreadIds: [] })
  })

  it('a sub-agent names its parent — the only thread of the pair the app knows', () => {
    expect(extractCodexCaller(SUBAGENT)).toEqual({ threadId: 'T-child', ancestorThreadIds: ['T-parent'] })
  })

  it('a nested sub-agent lists the nearest ancestor first, then the session root', () => {
    expect(extractCodexCaller(NESTED_SUBAGENT)).toEqual({
      threadId: 'T-grandchild',
      ancestorThreadIds: ['T-child', 'T-root'],
    })
  })

  // A fork is its own conversation. When the app forks it re-points the chat at
  // the fork; a fork the app did not make belongs to no chat. Treating the
  // source as an ancestor would file the fork's output under the source's chat.
  it('does NOT treat the thread a fork was copied from as an ancestor', () => {
    const caller = extractCodexCaller(FORK)
    expect(caller).toEqual({ threadId: 'T-fork', ancestorThreadIds: [] })
    expect(callerCodexThreadIds(caller!)).not.toContain('T-source')
  })

  it('falls back to the turn metadata when the top-level threadId is missing', () => {
    expect(
      extractCodexCaller(ctx({ 'x-codex-turn-metadata': { thread_id: 'T-turn', session_id: 'T-turn' } })),
    ).toEqual({ threadId: 'T-turn', ancestorThreadIds: [] })
  })

  it('a caller that names only a session has no own thread, just that ancestor', () => {
    expect(extractCodexCaller(ctx({ sessionId: 'S-only' }))).toEqual({ ancestorThreadIds: ['S-only'] })
  })

  it.each([
    ['no ctx', undefined],
    ['no mcpReq', {}],
    ['no _meta', { mcpReq: {} }],
    ['null _meta', ctx(null)],
    ['empty _meta', ctx({})],
    ['_meta of another client', ctx({ progressToken: 7 })],
  ])('is undefined when nothing identifies the caller (%s)', (_label, input) => {
    expect(extractCodexCaller(input)).toBeUndefined()
  })

  // A malformed `_meta` must degrade to "unknown caller", never to a junk id
  // that could collide with something or be written into a log.
  it('ignores ids that are not non-empty strings', () => {
    expect(
      extractCodexCaller(
        ctx({
          threadId: 42,
          sessionId: '',
          'x-codex-turn-metadata': { thread_id: { nested: true }, parent_thread_id: ['x'], session_id: null },
        }),
      ),
    ).toBeUndefined()
  })
})

describe('mergeToolCaller', () => {
  it('is undefined when neither side knows anything', () => {
    expect(mergeToolCaller(undefined, undefined)).toBeUndefined()
    expect(mergeToolCaller('', undefined)).toBeUndefined()
  })

  it('uses the ambient caller when the tool forwarded nothing', () => {
    const ambient = { threadId: 'T-child', ancestorThreadIds: ['T-parent'] }
    expect(mergeToolCaller(undefined, ambient)).toEqual(ambient)
  })

  it('an explicit id with no ambient scope is a caller without lineage', () => {
    expect(mergeToolCaller('T-explicit', undefined)).toEqual({ threadId: 'T-explicit', ancestorThreadIds: [] })
  })

  it('the explicit id equal to the ambient thread adds nothing and loses nothing', () => {
    expect(mergeToolCaller('T-child', { threadId: 'T-child', ancestorThreadIds: ['T-parent'] })).toEqual({
      threadId: 'T-child',
      ancestorThreadIds: ['T-parent'],
    })
  })

  it('never lists a thread twice or as its own ancestor', () => {
    expect(
      mergeToolCaller('T-parent', { threadId: 'T-child', ancestorThreadIds: ['T-parent', 'T-root'] }),
    ).toEqual({ threadId: 'T-parent', ancestorThreadIds: ['T-child', 'T-root'] })
  })
})

describe('runWithToolCaller', () => {
  it('exposes the caller inside the scope and nothing outside it', async () => {
    expect(currentToolCaller()).toBeUndefined()
    const caller = { threadId: 'T-1', ancestorThreadIds: [] }

    await runWithToolCaller(caller, async () => {
      expect(currentToolCaller()).toBe(caller)
      await new Promise((resolve) => setTimeout(resolve, 1))
      expect(currentToolCaller()).toBe(caller)
    })

    expect(currentToolCaller()).toBeUndefined()
  })

  // A handler invoked from inside another handler's flow (main-side
  // orchestration) with no caller of its own must not inherit the outer one.
  it('an inner scope with no caller hides the outer caller', () => {
    runWithToolCaller({ threadId: 'T-outer', ancestorThreadIds: [] }, () => {
      runWithToolCaller(undefined, () => {
        expect(currentToolCaller()).toBeUndefined()
      })
      expect(currentToolCaller()?.threadId).toBe('T-outer')
    })
  })
})

describe('withToolCallerScope', () => {
  type Handler = (...args: unknown[]) => unknown

  function fakeServer(): { registered: Map<string, Handler>; server: never; other: ReturnType<typeof vi.fn> } {
    const registered = new Map<string, Handler>()
    const other = vi.fn(function (this: unknown) {
      return this
    })
    const server = {
      marker: 'real-server',
      registerTool(name: string, _config: unknown, handler: Handler) {
        registered.set(name, handler)
        return { name }
      },
      registerResource: other,
    }
    return { registered, server: server as never, other }
  }

  it('runs each registered handler with the caller taken from its ctx', async () => {
    const { registered, server } = fakeServer()
    const seen: unknown[] = []
    withToolCallerScope(server).registerTool(
      'canvas_snapshot',
      {} as never,
      (async () => {
        seen.push(currentToolCaller())
        return { content: [] }
      }) as never,
    )

    await registered.get('canvas_snapshot')!({ some: 'args' }, SUBAGENT)

    expect(seen).toEqual([{ threadId: 'T-child', ancestorThreadIds: ['T-parent'] }])
  })

  // The SDK calls a tool that has no input schema with the ctx as the ONLY argument.
  it('finds the ctx when it is the only argument', async () => {
    const { registered, server } = fakeServer()
    let seen: unknown = 'unset'
    withToolCallerScope(server).registerTool('director_snapshot', {} as never, (() => {
      seen = currentToolCaller()
      return { content: [] }
    }) as never)

    await registered.get('director_snapshot')!(PLAIN)

    expect(seen).toEqual({ threadId: 'T-plain', ancestorThreadIds: [] })
  })

  it('passes arguments and the return value through untouched', async () => {
    const { registered, server } = fakeServer()
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    withToolCallerScope(server).registerTool('t', {} as never, handler as never)

    const args = { prompt: 'p' }
    await expect(registered.get('t')!(args, PLAIN)).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(handler).toHaveBeenCalledWith(args, PLAIN)
  })

  it('returns what the real registerTool returns, and lets a handler throw', async () => {
    const { registered, server } = fakeServer()
    const result = withToolCallerScope(server).registerTool('t', {} as never, (() => {
      throw new Error('tool failed')
    }) as never)

    expect(result).toEqual({ name: 't' })
    expect(() => registered.get('t')!({}, PLAIN)).toThrow('tool failed')
  })

  it('leaves everything else on the server alone, bound to the real instance', () => {
    const { server, other } = fakeServer()
    const scoped = withToolCallerScope(server) as unknown as {
      marker: string
      registerResource: () => unknown
    }

    expect(scoped.marker).toBe('real-server')
    // Called off the proxy, `this` must still be the real server (SDK methods touch private state).
    expect(scoped.registerResource()).toBe(server)
    expect(other).toHaveBeenCalledTimes(1)
  })
})
