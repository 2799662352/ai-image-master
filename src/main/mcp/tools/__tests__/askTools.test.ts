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
      expect(router.call).toHaveBeenCalledWith('ask_user', { question: 'q', options: [] })
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
    expect(router.call).toHaveBeenCalledWith('ask_user', { question: 'q', options: [] })
    expect(result.content[0].type).toBe('text')
    expect(JSON.parse(result.content[0].text as string)).toEqual(answer)
  })
})
