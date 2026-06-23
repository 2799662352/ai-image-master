import { describe, expect, it, vi } from 'vitest'

const relayBufferToCos = vi.fn(async () => 'https://cos.example.com/image-history/media-relay/x.mp4')
const relayDataUrlToCos = vi.fn(async () => 'https://cos.example.com/image-history/media-relay/data.mp4')
const relayFileToCos = vi.fn(async () => 'https://cos.example.com/image-history/media-relay/stream.mp4')
vi.mock('../../../services/tencent/mediaRelay', () => ({
  relayBufferToCos: (...args: unknown[]) => relayBufferToCos(...(args as [])),
  relayDataUrlToCos: (...args: unknown[]) => relayDataUrlToCos(...(args as [])),
  relayFileToCos: (...args: unknown[]) => relayFileToCos(...(args as [])),
}))

const fsStat = vi.fn(async () => ({ size: 1234 }))
const fsReadFile = vi.fn(async () => Buffer.from('fake-video-bytes'))
vi.mock('node:fs', () => {
  const promises = {
    stat: (...args: unknown[]) => fsStat(...(args as [])),
    readFile: (...args: unknown[]) => fsReadFile(...(args as [])),
  }
  return { promises, default: { promises } }
})

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
  it('registers understand_video / understand_document / web_research / understand_canvas_video', () => {
    const { tools, server, router } = fakeServerAndRouter()
    registerUnderstandTools(server, router)
    for (const name of ['understand_video', 'understand_document', 'web_research', 'understand_canvas_video']) {
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

  it('auto-streams a local video_path to COS (no full-file read) and routes the public video_url', async () => {
    relayFileToCos.mockClear()
    relayBufferToCos.mockClear()
    fsStat.mockClear()
    fsReadFile.mockClear()
    const { tools, server, router } = fakeServerAndRouter(async () => ({ success: true, text: '一只猫' }))
    registerUnderstandTools(server, router)

    await tools.get('understand_video')!({ video_path: 'C:/clips/cat.mp4', question: 'q' })

    // Streamed from disk (slice upload), NOT read into a Buffer.
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(relayBufferToCos).not.toHaveBeenCalled()
    expect(relayFileToCos).toHaveBeenCalledTimes(1)
    expect(relayFileToCos.mock.calls[0][0]).toBe('C:/clips/cat.mp4')
    expect(relayFileToCos.mock.calls[0][1]).toBe('video/mp4')
    const [name, sentParams] = router.call.mock.calls[0]
    expect(name).toBe('understand_video')
    expect(sentParams.video_url).toBe('https://cos.example.com/image-history/media-relay/stream.mp4')
    expect(sentParams.video_path).toBeUndefined()
  })

  it('accepts a large local file well over the old 200MB cap (e.g. 300MB) via streaming', async () => {
    relayFileToCos.mockClear()
    fsStat.mockResolvedValueOnce({ size: 300 * 1024 * 1024 } as any)
    const { tools, server, router } = fakeServerAndRouter(async () => ({ success: true, text: 'ok' }))
    registerUnderstandTools(server, router)

    await tools.get('understand_video')!({ video_path: 'C:/clips/big.mp4', question: 'q' })

    expect(relayFileToCos).toHaveBeenCalledTimes(1)
    expect(router.call).toHaveBeenCalledTimes(1)
    expect(router.call.mock.calls[0][1].video_url).toBe('https://cos.example.com/image-history/media-relay/stream.mp4')
  })

  it('passes a public http video_url through without uploading', async () => {
    relayBufferToCos.mockClear()
    fsReadFile.mockClear()
    const { tools, server, router } = fakeServerAndRouter()
    registerUnderstandTools(server, router)

    await tools.get('understand_video')!({ video_url: 'https://x/a.mp4', question: 'q' })

    expect(relayBufferToCos).not.toHaveBeenCalled()
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(router.call.mock.calls[0][1].video_url).toBe('https://x/a.mp4')
  })

  it('relays a data: video_url to COS', async () => {
    relayDataUrlToCos.mockClear()
    const { tools, server, router } = fakeServerAndRouter()
    registerUnderstandTools(server, router)

    await tools.get('understand_video')!({ video_url: 'data:video/mp4;base64,AAAA', question: 'q' })

    expect(relayDataUrlToCos).toHaveBeenCalledWith('data:video/mp4;base64,AAAA')
    expect(router.call.mock.calls[0][1].video_url).toBe('https://cos.example.com/image-history/media-relay/data.mp4')
  })

  it('refuses a local file over the objective 2GB upstream limit and does not call router.call', async () => {
    relayFileToCos.mockClear()
    fsStat.mockResolvedValueOnce({ size: 3 * 1024 * 1024 * 1024 } as any)
    const { tools, server, router } = fakeServerAndRouter()
    registerUnderstandTools(server, router)

    const res = await tools.get('understand_video')!({ video_path: 'C:/huge.mp4', question: 'q' })

    expect(relayFileToCos).not.toHaveBeenCalled()
    expect(router.call).not.toHaveBeenCalled()
    expect(firstText(res)).toContain('2GB')
  })

  it('returns a structured error when neither url nor path is provided', async () => {
    const { tools, server, router } = fakeServerAndRouter()
    registerUnderstandTools(server, router)

    const res = await tools.get('understand_document')!({ question: 'q' })

    expect(router.call).not.toHaveBeenCalled()
    expect(firstText(res)).toContain('缺少 file_url 或 file_path')
  })

  it('understand_canvas_video: reads the selected canvas video, uploads its local source, understands, and annotates the canvas', async () => {
    relayFileToCos.mockClear()
    relayBufferToCos.mockClear()
    fsReadFile.mockClear()
    fsStat.mockClear()
    const calls: Array<[string, any]> = []
    const callImpl = async (name: string, params: any) => {
      calls.push([name, params])
      if (name === 'get_selected_canvas_video') return { ok: true, shapeId: 'shape:v1', assetPath: 'C:/clips/cat.mp4', assetUrl: null, title: '猫' }
      if (name === 'understand_video') return { success: true, text: '一只猫在跳' }
      if (name === 'add_canvas_note') return { ok: true, shapeId: 'shape:note1' }
      return { success: true, text: 'ok' }
    }
    const { tools, server, router } = fakeServerAndRouter(callImpl)
    registerUnderstandTools(server, router)

    const res = await tools.get('understand_canvas_video')!({ question: '这是什么' })

    expect(calls[0][0]).toBe('get_selected_canvas_video')
    // local assetPath was auto-streamed to COS (no full-file read)
    expect(relayFileToCos).toHaveBeenCalledTimes(1)
    expect(relayBufferToCos).not.toHaveBeenCalled()
    const uv = calls.find((c) => c[0] === 'understand_video')!
    expect(uv[1].video_url).toBe('https://cos.example.com/image-history/media-relay/stream.mp4')
    expect(uv[1].question).toBe('这是什么')
    // result written back as a note next to the video
    const note = calls.find((c) => c[0] === 'add_canvas_note')!
    expect(note[1].nearShapeId).toBe('shape:v1')
    expect(note[1].text).toContain('一只猫在跳')
    expect(firstText(res)).toContain('一只猫在跳')
    expect(firstText(res)).toContain('shape:note1')
  })

  it('understand_canvas_video: surfaces a "no video" canvas error without uploading or understanding', async () => {
    relayFileToCos.mockClear()
    relayBufferToCos.mockClear()
    const calls: string[] = []
    const callImpl = async (name: string) => {
      calls.push(name)
      if (name === 'get_selected_canvas_video') return { ok: false, error: '画布上没有视频。先把视频拖到画布(或用 insert_video 放一个)再试。' }
      return { success: true, text: 'ok' }
    }
    const { tools, server, router } = fakeServerAndRouter(callImpl)
    registerUnderstandTools(server, router)

    const res = await tools.get('understand_canvas_video')!({ question: 'q' })

    expect(calls).toEqual(['get_selected_canvas_video'])
    expect(relayFileToCos).not.toHaveBeenCalled()
    expect(relayBufferToCos).not.toHaveBeenCalled()
    expect(firstText(res)).toContain('没有视频')
  })

  it('understand_canvas_video: annotate=false returns the text but skips the canvas note', async () => {
    const calls: string[] = []
    const callImpl = async (name: string) => {
      calls.push(name)
      if (name === 'get_selected_canvas_video') return { ok: true, shapeId: 'shape:v1', assetPath: null, assetUrl: 'https://x/a.mp4', title: null }
      if (name === 'understand_video') return { success: true, text: 'desc' }
      return { ok: true }
    }
    const { tools, server, router } = fakeServerAndRouter(callImpl)
    registerUnderstandTools(server, router)

    const res = await tools.get('understand_canvas_video')!({ question: 'q', annotate: false })

    expect(calls).not.toContain('add_canvas_note')
    expect(firstText(res)).toContain('desc')
  })
})
