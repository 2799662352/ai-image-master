import { describe, expect, it, vi } from 'vitest'
import { ToolRouter, type ToolThreadResolver } from '../ToolRouter'
import { runWithToolCaller, type CodexToolCaller, type ToolThreadResolution } from '../toolCaller'

/** A resolver that knows only the caller's OWN thread — the pre-lineage behaviour. */
function byThread(map: Record<string, string>): ToolThreadResolver {
  return (caller) => {
    const dbThreadId = caller.threadId ? map[caller.threadId] : undefined
    return dbThreadId ? { threadId: dbThreadId, via: 'live' } : undefined
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('ToolRouter', () => {
  it('runs main handlers before renderer fallback', async () => {
    const win = { webContents: { send: vi.fn() } } as any
    const router = new ToolRouter(win)
    router.registerMain('ping', async () => ({ ok: true }))
    await expect(router.call('ping', {})).resolves.toEqual({ ok: true })
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('maps the codex thread id to a db thread id on the renderer request', () => {
    const send = vi.fn()
    const win = { webContents: { send } } as any
    const router = new ToolRouter(win)
    router.setThreadResolver(byThread({ 'codex-uuid-1': 'db-thread-1' }))

    void router.call('generate_image', { prompt: 'a cat' }, 'codex-uuid-1')

    // Same tick: an in-memory answer must not delay the renderer request.
    expect(send).toHaveBeenCalledTimes(1)
    const [, request] = send.mock.calls[0]
    expect(request.toolName).toBe('generate_image')
    expect(request.threadId).toBe('db-thread-1')
  })

  it('omits threadId when no chat owns the caller — the renderer runs the tool detached', () => {
    const send = vi.fn()
    const win = { webContents: { send } } as any
    const router = new ToolRouter(win)
    router.setThreadResolver(() => undefined)

    void router.call('generate_image', { prompt: 'a cat' }, 'unknown-codex-id')

    const [, request] = send.mock.calls[0]
    expect('threadId' in request).toBe(false)
  })

  describe('caller no chat owns', () => {
    // Such a call used to be handed to whichever chat was open — the path that
    // put one conversation's images into another. It now runs detached, and it
    // must never do so silently.
    it('warns, naming the tool and every codex thread the caller reported', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const router = new ToolRouter({ webContents: { send: vi.fn() } } as any)
        router.setThreadResolver(() => undefined)

        runWithToolCaller({ threadId: 'child-id', ancestorThreadIds: ['parent-id'] }, () => {
          void router.call('ask_user', { question: 'q' })
        })

        expect(warn).toHaveBeenCalledTimes(1)
        const text = warn.mock.calls[0].map(String).join(' ')
        expect(text).toContain('ask_user')
        expect(text).toContain('child-id')
        expect(text).toContain('parent-id')
        // The old wording promised a fallback that no longer exists.
        expect(text).not.toMatch(/ACTIVE chat/i)
      } finally {
        warn.mockRestore()
      }
    })

    it('stays quiet when the id maps, or when no id was supplied at all', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const router = new ToolRouter({ webContents: { send: vi.fn() } } as any)
        router.setThreadResolver(byThread({ known: 'db-1' }))

        void router.call('ask_user', { question: 'q' }, 'known')
        void router.call('ask_user', { question: 'q' })

        expect(warn).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('caller scope (the tool handler\'s `_meta`, not a hand-forwarded id)', () => {
    // Most tools never forwarded the caller — the canvas-export and director
    // tools among them — so their output could only ever go to the open chat.
    // Inside a caller scope a bare `router.call(name, params)` is attributed.
    it('attributes a call that forwards nothing', () => {
      const send = vi.fn()
      const router = new ToolRouter({ webContents: { send } } as any)
      router.setThreadResolver(byThread({ 'codex-1': 'db-1' }))

      runWithToolCaller({ threadId: 'codex-1', ancestorThreadIds: [] }, () => {
        void router.call('canvas_snapshot', {})
      })

      expect(send.mock.calls[0][1].threadId).toBe('db-1')
    })

    it('still attributes a call issued later in the same async flow', async () => {
      const send = vi.fn()
      const router = new ToolRouter({ webContents: { send } } as any)
      router.setThreadResolver(byThread({ 'codex-1': 'db-1' }))

      await runWithToolCaller({ threadId: 'codex-1', ancestorThreadIds: [] }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        void router.call('director_snapshot', {})
      })

      expect(send.mock.calls[0][1].threadId).toBe('db-1')
    })

    it('keeps two overlapping handlers apart', async () => {
      const send = vi.fn()
      const router = new ToolRouter({ webContents: { send } } as any)
      router.setThreadResolver(byThread({ 'codex-a': 'db-a', 'codex-b': 'db-b' }))

      const run = (codexId: string, delayMs: number): Promise<void> =>
        runWithToolCaller({ threadId: codexId, ancestorThreadIds: [] }, async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          void router.call('canvas_snapshot', { from: codexId })
        })
      // B starts second but finishes first: neither may inherit the other's caller.
      await Promise.all([run('codex-a', 20), run('codex-b', 5)])

      const byParam = new Map(send.mock.calls.map(([, req]) => [req.params.from, req.threadId]))
      expect(byParam.get('codex-a')).toBe('db-a')
      expect(byParam.get('codex-b')).toBe('db-b')
    })

    it('hands the resolver the whole lineage, so an unknown child resolves through its parent', () => {
      const send = vi.fn()
      const router = new ToolRouter({ webContents: { send } } as any)
      const resolver = vi.fn((caller: CodexToolCaller): ToolThreadResolution | undefined =>
        caller.ancestorThreadIds.includes('parent-codex') ? { threadId: 'db-parent', via: 'ancestor' } : undefined,
      )
      router.setThreadResolver(resolver)

      runWithToolCaller({ threadId: 'child-codex', ancestorThreadIds: ['parent-codex'] }, () => {
        // The tool forwards the child's own id the old way; the lineage must survive.
        void router.call('generate_image', { prompt: 'x' }, 'child-codex')
      })

      expect(resolver).toHaveBeenCalledWith({ threadId: 'child-codex', ancestorThreadIds: ['parent-codex'] })
      expect(send.mock.calls[0][1].threadId).toBe('db-parent')
    })

    it('an explicit id that differs from the scope keeps the scope\'s thread as lineage', () => {
      const router = new ToolRouter({ webContents: { send: vi.fn() } } as any)
      const resolver = vi.fn(() => undefined)
      router.setThreadResolver(resolver)

      runWithToolCaller({ threadId: 'scope-thread', ancestorThreadIds: ['scope-parent'] }, () => {
        void router.call('generate_image', {}, 'explicit-thread')
      })

      expect(resolver).toHaveBeenCalledWith({
        threadId: 'explicit-thread',
        ancestorThreadIds: ['scope-thread', 'scope-parent'],
      })
    })

    it('does not consult the resolver for a call nobody is behind', () => {
      const send = vi.fn()
      const router = new ToolRouter({ webContents: { send } } as any)
      const resolver = vi.fn(() => undefined)
      router.setThreadResolver(resolver)

      void router.call('query_history', {})

      expect(resolver).not.toHaveBeenCalled()
      expect('threadId' in send.mock.calls[0][1]).toBe(false)
    })
  })

  describe('resolution happens once, and never breaks the call', () => {
    it('resolves once per call and gives the SAME answer to a main handler', async () => {
      const router = new ToolRouter({ webContents: { send: vi.fn() } } as any)
      const resolver = vi.fn(byThread({ 'codex-1': 'db-1' }))
      router.setThreadResolver(resolver)
      const handler = vi.fn(async () => 'ok')
      router.registerMain('generate_video', handler)

      await router.call('generate_video', { prompt: 'p' }, 'codex-1')

      expect(resolver).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({ prompt: 'p' }, 'db-1')
    })

    it('resolves once per call on the renderer path too', () => {
      const router = new ToolRouter({ webContents: { send: vi.fn() } } as any)
      const resolver = vi.fn(byThread({ 'codex-1': 'db-1' }))
      router.setThreadResolver(resolver)

      void router.call('generate_image', {}, 'codex-1')

      expect(resolver).toHaveBeenCalledTimes(1)
    })

    it('waits for an asynchronous answer (database lookup) before sending', async () => {
      const send = vi.fn()
      const router = new ToolRouter({ webContents: { send } } as any)
      let release: (value: ToolThreadResolution) => void = () => {}
      router.setThreadResolver(() => new Promise<ToolThreadResolution>((resolve) => { release = resolve }))

      void router.call('generate_image', {}, 'cold-codex')
      await flush()
      // Sending now would mean sending without an owner — the bug.
      expect(send).not.toHaveBeenCalled()

      release({ threadId: 'db-cold', via: 'persisted' })
      await flush()
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][1].threadId).toBe('db-cold')
    })

    it.each([
      ['throws', () => { throw new Error('map exploded') }],
      ['rejects', () => Promise.reject(new Error('db down'))],
    ])('a resolver that %s degrades to detached instead of failing the tool', async (_label, resolver) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const send = vi.fn()
        const router = new ToolRouter({ webContents: { send } } as any)
        router.setThreadResolver(resolver as never)
        const handler = vi.fn(async () => 'ran')
        router.registerMain('generate_video', handler)

        await expect(router.call('generate_video', {}, 'codex-1')).resolves.toBe('ran')
        expect(handler).toHaveBeenCalledWith({}, undefined)

        void router.call('generate_image', {}, 'codex-1')
        await flush()
        expect('threadId' in send.mock.calls[0][1]).toBe(false)
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('renderer tool timeouts', () => {
    it('a regular renderer tool still times out at the ~33-min ceiling', async () => {
      vi.useFakeTimers()
      try {
        const win = { webContents: { send: vi.fn() } } as any
        const router = new ToolRouter(win)
        const call = router.call('generate_image', { prompt: 'x' })
        call.catch(() => {}) // avoid an unhandled rejection between ticks

        vi.advanceTimersByTime(2_000_000 + 1)

        await expect(call).rejects.toThrow('Renderer tool timed out: generate_image')
      } finally {
        vi.useRealTimers()
      }
    })

    it('ask_user survives the regular ceiling and only times out after 6 hours', async () => {
      vi.useFakeTimers()
      try {
        const send = vi.fn()
        const win = { webContents: { send } } as any
        const router = new ToolRouter(win)
        const call = router.call('ask_user', { question: 'q' })
        const settled = vi.fn()
        call.catch(settled)

        // Past the regular renderer ceiling: the human may still be away.
        vi.advanceTimersByTime(2_000_000 + 1)
        await Promise.resolve()
        expect(settled).not.toHaveBeenCalled()

        // A late click still resolves the pending call.
        const [, request] = send.mock.calls[0]
        router.handleRendererResponse({ id: request.id, ok: true, result: { answered: true } })
        await expect(call).resolves.toEqual({ answered: true })
      } finally {
        vi.useRealTimers()
      }
    })

    it('ask_user rejects once the 6-hour window elapses', async () => {
      vi.useFakeTimers()
      try {
        const win = { webContents: { send: vi.fn() } } as any
        const router = new ToolRouter(win)
        const call = router.call('ask_user', { question: 'q' })
        call.catch(() => {}) // avoid an unhandled rejection between ticks

        vi.advanceTimersByTime(21_600_000 + 1)

        await expect(call).rejects.toThrow('Renderer tool timed out: ask_user')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('failAllPending (renderer reload / crash)', () => {
    it('rejects every pending renderer call immediately with the given reason', async () => {
      const win = { webContents: { send: vi.fn() } } as any
      const router = new ToolRouter(win)

      const a = router.call('generate_image', { prompt: 'x' })
      const b = router.call('ask_user', { question: 'q' })
      a.catch(() => {})
      b.catch(() => {})

      const rejected = router.failAllPending('renderer reloaded')

      expect(rejected).toBe(2)
      await expect(a).rejects.toThrow('renderer reloaded')
      await expect(b).rejects.toThrow('renderer reloaded')
    })

    it('is a no-op when nothing is pending and late responses stay ignored', () => {
      const win = { webContents: { send: vi.fn() } } as any
      const router = new ToolRouter(win)

      expect(router.failAllPending('renderer reloaded')).toBe(0)
      // A stray response for an already-failed id must not throw.
      expect(() => router.handleRendererResponse({ id: 'nope', ok: true, result: {} } as any)).not.toThrow()
    })

    it('clears the pending timeout so no late spurious rejection fires', async () => {
      vi.useFakeTimers()
      try {
        const win = { webContents: { send: vi.fn() } } as any
        const router = new ToolRouter(win)
        const call = router.call('generate_image', { prompt: 'x' })
        call.catch(() => {})
        expect(vi.getTimerCount()).toBe(1)

        router.failAllPending('renderer reloaded')

        // The per-call timeout is gone — nothing left to fire later.
        expect(vi.getTimerCount()).toBe(0)
        await expect(call).rejects.toThrow('renderer reloaded')
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
