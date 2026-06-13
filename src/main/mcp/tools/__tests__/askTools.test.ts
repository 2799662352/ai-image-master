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

describe('registerAskTools', () => {
  it('registers a single ask_user tool with a concise description', () => {
    const { tools, server, router } = capture()
    registerAskTools(server, router)
    expect(tools.map((t) => t.name)).toEqual(['ask_user'])
    expect(tools[0].config.description.length).toBeLessThan(500)
  })

  it('schema requires a question and defaults the optional fields', () => {
    const { tools, server, router } = capture()
    registerAskTools(server, router)
    const schema = tools[0].config.inputSchema

    expect(schema.safeParse({ question: '' }).success).toBe(false)

    const parsed = schema.safeParse({ question: '想要什么景别?' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.mode).toBe('single')
      expect(parsed.data.allowFreeText).toBe(true)
      expect(parsed.data.allowSkip).toBe(true)
      expect(parsed.data.options).toEqual([])
    }
  })

  it('schema rejects options missing id/label and bad mode', () => {
    const { tools, server, router } = capture()
    registerAskTools(server, router)
    const schema = tools[0].config.inputSchema
    expect(schema.safeParse({ question: 'q', options: [{ label: 'A' }] }).success).toBe(false)
    expect(schema.safeParse({ question: 'q', mode: 'triple' }).success).toBe(false)
    expect(
      schema.safeParse({ question: 'q', options: [{ id: 'a', label: 'A' }], mode: 'multi' }).success,
    ).toBe(true)
  })

  it('routes to the renderer and wraps the answer as JSON text content', async () => {
    const answer = { answered: true, skipped: false, selected: [{ id: 'a', label: 'A' }] }
    const { tools, server, router } = capture(answer)
    registerAskTools(server, router)

    const result = await tools[0].handler({ question: 'q', options: [] })
    expect(router.call).toHaveBeenCalledWith('ask_user', { question: 'q', options: [] })
    expect(result.content[0].type).toBe('text')
    expect(JSON.parse(result.content[0].text as string)).toEqual(answer)
  })
})
