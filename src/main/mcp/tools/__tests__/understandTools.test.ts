import { describe, expect, it, vi } from 'vitest'
import { registerUnderstandTools } from '../understandTools'

function fakeServerAndRouter(callImpl?: (name: string, params: any) => Promise<unknown>) {
  const tools = new Map<string, (params: any, ctx?: unknown) => Promise<any>>()
  const server = {
    registerTool: (name: string, _schema: unknown, handler: any) => tools.set(name, handler),
  } as any
  const router = {
    registerMain: vi.fn(),
    call: vi.fn(callImpl ?? (async () => ({ success: true, text: 'ok' }))),
  } as any
  return { tools, server, router }
}

function firstText(res: any): string {
  return res?.content?.[0]?.text ?? ''
}

describe('registerUnderstandTools', () => {
  it('registers understand_video / understand_document / web_research', () => {
    const { tools, server, router } = fakeServerAndRouter()
    registerUnderstandTools(server, router)
    for (const name of ['understand_video', 'understand_document', 'web_research']) {
      expect(tools.has(name)).toBe(true)
    }
  })

  it('routes web_research to the renderer via router.call', async () => {
    const { tools, server, router } = fakeServerAndRouter()
    registerUnderstandTools(server, router)
    await tools.get('web_research')!({ query: '今天的新闻' })
    expect(router.call).toHaveBeenCalledWith('web_research', expect.objectContaining({ query: '今天的新闻' }), undefined)
  })

  it('wraps a successful understand result as text content', async () => {
    const { tools, server, router } = fakeServerAndRouter(async () => ({ success: true, text: '画面里有一只猫' }))
    registerUnderstandTools(server, router)
    const res = await tools.get('understand_video')!({ video_url: 'https://x/a.mp4', question: 'q' })
    expect(firstText(res)).toContain('画面里有一只猫')
  })

  it('surfaces a structured error from understand as text content', async () => {
    const { tools, server, router } = fakeServerAndRouter(async () => ({ success: false, error: '上游繁忙' }))
    registerUnderstandTools(server, router)
    const res = await tools.get('web_research')!({ query: 'x' })
    expect(firstText(res)).toContain('上游繁忙')
  })

  it('does not throw when router.call rejects', async () => {
    const { tools, server, router } = fakeServerAndRouter(async () => {
      throw new Error('boom')
    })
    registerUnderstandTools(server, router)
    const res = await tools.get('understand_document')!({ file_url: 'https://x/a.pdf', question: 'q' })
    expect(firstText(res)).toContain('boom')
  })
})
