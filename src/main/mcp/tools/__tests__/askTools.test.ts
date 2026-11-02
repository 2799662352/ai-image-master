import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { registerAskTools } from '../askTools'

type Handler = (
  params: Record<string, unknown>,
  ctx?: unknown,
) => Promise<{ content: Array<Record<string, unknown>> }>
type Captured = {
  name: string
  config: { description: string; inputSchema: ZodTypeAny }
  handler: Handler
}

function capture(routerResult: unknown = { answered: true, skipped: false, selected: [] }): {
  tools: Captured[]
  server: any
  router: any
} {
  const tools: Captured[] = []
  const server = {
    registerTool: (name: string, config: Captured['config'], handler: Handler) => {
      tools.push({ name, config, handler })
    },
  }
  const router = { call: vi.fn(async () => routerResult) }
  return { tools, server, router }
}

const canonicalOf = (tools: Captured[]) => tools.find((t) => t.name === 'ask_user')!

describe('registerAskTools', () => {
  it('registers the canonical ask_user first, then hardcoded name aliases', () => {
    const { tools, server, router } = capture()
    registerAskTools(server, router)
    const names = tools.map((t) => t.name)
    // Canonical is first and carries the rich, model-facing description.
    expect(names[0]).toBe('ask_user')
    expect(canonicalOf(tools).config.description.length).toBeLessThan(500)
    expect(canonicalOf(tools).config.description).toContain('ask_user')
    // The exact mis-spellings observed in real-run codex logs MUST be
    // dispatchable registry entries so the option card still pops.
    expect(names).toEqual(
      expect.arrayContaining(['askuser', 'catimationaskuser', 'catimation_ask_user']),
    )
    // No duplicate names (each alias registered once).
    expect(new Set(names).size).toBe(names.length)
  })

  it('routes EVERY registered variant to the canonical ask_user renderer tool', async () => {
    const answer = { answered: true, skipped: false, selected: [{ id: 'a', label: 'A' }] }
    const { tools, server, router } = capture(answer)
    registerAskTools(server, router)
    expect(tools.length).toBeGreaterThan(1)

    for (const tool of tools) {
      router.call.mockClear()
      const result = await tool.handler({ question: 'q', options: [] })
      // A mis-spelled MCP tool name still drives the one true `ask_user` card.
      expect(router.call).toHaveBeenCalledWith('ask_user', { question: 'q', options: [] }, undefined)
      expect(result.content[0].type).toBe('text')
      expect(JSON.parse(result.content[0].text as string)).toEqual(answer)
    }
  })

  it('every variant shares the same schema (requires a question, defaults optionals)', () => {
    const { tools, server, router } = capture()
    registerAskTools(server, router)
    for (const tool of tools) {
      const schema = tool.config.inputSchema
      expect(schema.safeParse({ question: '' }).success).toBe(false)
      const parsed = schema.safeParse({ question: '想要什么景别?' })
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data.mode).toBe('single')
        expect(parsed.data.allowFreeText).toBe(true)
        expect(parsed.data.allowSkip).toBe(true)
        expect(parsed.data.options).toEqual([])
      }
    }
  })

  it('schema rejects options missing id/label and bad mode', () => {
    const { tools, server, router } = capture()
    registerAskTools(server, router)
    const schema = canonicalOf(tools).config.inputSchema
    expect(schema.safeParse({ question: 'q', options: [{ label: 'A' }] }).success).toBe(false)
    expect(schema.safeParse({ question: 'q', mode: 'triple' }).success).toBe(false)
    expect(
      schema.safeParse({ question: 'q', options: [{ id: 'a', label: 'A' }], mode: 'multi' }).success,
    ).toBe(true)
  })

  it('wraps the renderer answer as JSON text content', async () => {
    const answer = { answered: true, skipped: false, selected: [{ id: 'a', label: 'A' }] }
    const { tools, server, router } = capture(answer)
    registerAskTools(server, router)

    const result = await canonicalOf(tools).handler({ question: 'q', options: [] })
    expect(router.call).toHaveBeenCalledWith('ask_user', { question: 'q', options: [] }, undefined)
    expect(result.content[0].type).toBe('text')
    expect(JSON.parse(result.content[0].text as string)).toEqual(answer)
  })

  describe('thread routing (the card must land in the thread that asked)', () => {
    // Codex stamps every MCP `tools/call` with the id of the thread that made
    // it. Without forwarding it, the renderer falls back to whichever chat the
    // user is LOOKING at — so a card asked by a background thread popped up in
    // the foreground one.
    const ctxWith = (meta: Record<string, unknown>) => ({ mcpReq: { _meta: meta } })

    it('forwards the codex thread id from `_meta.threadId` on every variant', async () => {
      const { tools, server, router } = capture()
      registerAskTools(server, router)

      for (const tool of tools) {
        router.call.mockClear()
        await tool.handler({ question: 'q' }, ctxWith({ threadId: 'codex-thread-A' }))
        expect(router.call).toHaveBeenCalledWith('ask_user', { question: 'q' }, 'codex-thread-A')
      }
    })

    it('falls back to `x-codex-turn-metadata.thread_id` when `_meta.threadId` is absent', async () => {
      const { tools, server, router } = capture()
      registerAskTools(server, router)

      await canonicalOf(tools).handler(
        { question: 'q' },
        ctxWith({
          'x-codex-turn-metadata': { session_id: 'session-root', thread_id: 'codex-thread-B' },
        }),
      )

      // The concrete thread wins over the (shared) session id.
      expect(router.call).toHaveBeenCalledWith('ask_user', { question: 'q' }, 'codex-thread-B')
    })

    it('uses the session id only when no concrete thread id exists', async () => {
      const { tools, server, router } = capture()
      registerAskTools(server, router)

      await canonicalOf(tools).handler(
        { question: 'q' },
        ctxWith({ 'x-codex-turn-metadata': { session_id: 'session-root' } }),
      )

      expect(router.call).toHaveBeenCalledWith('ask_user', { question: 'q' }, 'session-root')
    })

    it('ignores empty / non-string ids rather than forwarding junk', async () => {
      const { tools, server, router } = capture()
      registerAskTools(server, router)

      await canonicalOf(tools).handler(
        { question: 'q' },
        ctxWith({ threadId: '', 'x-codex-turn-metadata': { thread_id: 42 } }),
      )

      expect(router.call).toHaveBeenCalledWith('ask_user', { question: 'q' }, undefined)
    })

    it('tolerates a missing / malformed ctx (older SDK, direct invocation)', async () => {
      const { tools, server, router } = capture()
      registerAskTools(server, router)

      await canonicalOf(tools).handler({ question: 'q' }, undefined)
      await canonicalOf(tools).handler({ question: 'q' }, {})
      await canonicalOf(tools).handler({ question: 'q' }, { mcpReq: null })

      expect(router.call).toHaveBeenCalledTimes(3)
      for (const call of router.call.mock.calls) {
        expect(call[2]).toBeUndefined()
      }
    })
  })

  it('documents the 5-minute auto-advance to the model within the description budget', () => {
    const { tools, server, router } = capture()
    registerAskTools(server, router)
    const description = canonicalOf(tools).config.description
    // The model must know an unanswered card is not a dead end: after 5 minutes
    // the user's silence resolves it with `timedOut: true`.
    expect(description).toContain('timedOut')
    expect(description.length).toBeLessThan(500)
  })
})
