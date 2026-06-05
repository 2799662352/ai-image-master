import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { registerImageTools } from '../imageTools'

type Captured = { name: string; config: { description: string; inputSchema: ZodTypeAny } }

function capture(): { tools: Captured[]; server: any; router: any } {
  const tools: Captured[] = []
  const server = {
    registerTool: (name: string, config: Captured['config']) => {
      tools.push({ name, config })
    },
  }
  const router = { call: vi.fn(async () => ({ ok: true })) }
  return { tools, server, router }
}

describe('registerImageTools / generate_image schema', () => {
  it('registers generate_image with a zod inputSchema', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const tool = tools.find((t) => t.name === 'generate_image')
    expect(tool).toBeDefined()
    expect(tool!.config.inputSchema).toBeDefined()
  })

  it('accepts the 3-axis params: prompt + ratio + resolution + quality', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    const result = schema.safeParse({
      prompt: 'a cat',
      ratio: '16:9',
      resolution: '2K',
      quality: 'high',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a bare prompt (all else optional)', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    expect(schema.safeParse({ prompt: 'a cat' }).success).toBe(true)
  })

  it('rejects an empty prompt', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    expect(schema.safeParse({ prompt: '' }).success).toBe(false)
  })

  it('rejects out-of-enum resolution and quality', () => {
    const { tools, server, router } = capture()
    registerImageTools(server, router)
    const schema = tools.find((t) => t.name === 'generate_image')!.config.inputSchema
    expect(schema.safeParse({ prompt: 'x', resolution: '8K' }).success).toBe(false)
    expect(schema.safeParse({ prompt: 'x', quality: 'ultra' }).success).toBe(false)
  })
})
