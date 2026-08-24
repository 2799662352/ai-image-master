import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ensureLayerSplitInputFormat } from '../layerSplitInput'

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}

/** 装一套最小可用的 fetch + createImageBitmap + OffscreenCanvas + FileReader。 */
function installTranscodeEnv(opts: {
  blobType?: string
  width?: number
  height?: number
  fetchOk?: boolean
} = {}) {
  const { blobType = 'image/webp', width = 1024, height = 1024, fetchOk = true } = opts

  g.fetch = vi.fn(async () => ({
    ok: fetchOk,
    status: fetchOk ? 200 : 404,
    blob: async () => ({ type: blobType }) as Blob,
  }))
  g.createImageBitmap = vi.fn(async () => ({ width, height, close: vi.fn() }))
  g.OffscreenCanvas = class {
    constructor(public width: number, public height: number) {}
    getContext() {
      return { drawImage: vi.fn() }
    }
    async convertToBlob() {
      return { type: 'image/png' } as Blob
    }
  }
  g.FileReader = class {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL() {
      this.result = 'data:image/png;base64,TRANSCODED'
      this.onload?.()
    }
  }
}

beforeEach(() => {
  for (const k of ['fetch', 'createImageBitmap', 'OffscreenCanvas', 'FileReader']) saved[k] = g[k]
})

afterEach(() => {
  for (const k of ['fetch', 'createImageBitmap', 'OffscreenCanvas', 'FileReader']) g[k] = saved[k]
  vi.restoreAllMocks()
})

/**
 * 上游 Seedream 5.0 Pro 的 `image` 只吃 png/jpeg。本 app 存在 COS 的历史图是 webp,
 * 所以「对历史图点拆分」必然踩中,而上游只回一句 image format is not supported。
 */
describe('ensureLayerSplitInputFormat', () => {
  it('png / jpeg 的 URL 原样放行 —— 保持 URL 形态，别把几 MB base64 塞进请求体', async () => {
    installTranscodeEnv()
    for (const url of ['https://x/a.png', 'https://x/a.jpg', 'https://x/a.JPEG']) {
      const r = await ensureLayerSplitInputFormat(url)
      expect(r.image, url).toBe(url)
      expect(r.transcoded, url).toBe(false)
    }
    expect(g.fetch).not.toHaveBeenCalled()
  })

  it('带 query 的 png URL 也认（COS 签名链接后面挂一串参数）', async () => {
    installTranscodeEnv()
    const url = 'https://x/a.png?sign=abc&t=1'
    expect((await ensureLayerSplitInputFormat(url)).image).toBe(url)
  })

  it('png / jpeg 的 data URI 原样放行', async () => {
    installTranscodeEnv()
    const d = 'data:image/jpeg;base64,AAAA'
    const r = await ensureLayerSplitInputFormat(d)
    expect(r.image).toBe(d)
    expect(r.transcoded).toBe(false)
  })

  it('webp URL 转成 PNG data URI —— 这是历史图拆分的必经之路', async () => {
    installTranscodeEnv({ blobType: 'image/webp' })
    const r = await ensureLayerSplitInputFormat('https://cos/x/a.webp')
    expect(r.transcoded).toBe(true)
    expect(r.image).toBe('data:image/png;base64,TRANSCODED')
  })

  it('webp data URI 同样转码', async () => {
    installTranscodeEnv({ blobType: 'image/webp' })
    const r = await ensureLayerSplitInputFormat('data:image/webp;base64,AAAA')
    expect(r.transcoded).toBe(true)
  })

  it('无后缀但取回来发现是 png：原样放行，不做无谓的重编码', async () => {
    installTranscodeEnv({ blobType: 'image/png' })
    const url = 'https://cos/x/abcdef'
    const r = await ensureLayerSplitInputFormat(url)
    expect(r.image).toBe(url)
    expect(r.transcoded).toBe(false)
  })

  it('转 PNG 而不是 JPEG —— webp 可能带透明，转 JPEG 会把透明区压成黑块', async () => {
    installTranscodeEnv({ blobType: 'image/webp' })
    let requested: string | undefined
    g.OffscreenCanvas = class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { drawImage: vi.fn() }
      }
      async convertToBlob(o: { type: string }) {
        requested = o.type
        return { type: o.type } as Blob
      }
    }
    await ensureLayerSplitInputFormat('https://cos/x/a.webp')
    expect(requested).toBe('image/png')
  })

  it('图太小时说清楚是多小、要求多大（上游只回一句 InvalidParameter）', async () => {
    installTranscodeEnv({ blobType: 'image/webp', width: 300, height: 900 })
    const r = await ensureLayerSplitInputFormat('https://cos/x/a.webp')
    expect(r.image).toBeNull()
    expect(r.error).toMatch(/300×900/)
    expect(r.error).toMatch(/512/)
  })

  it('取图失败时报错，而不是把 webp 原样发出去换一句上游黑话', async () => {
    installTranscodeEnv({ blobType: 'image/webp', fetchOk: false })
    const r = await ensureLayerSplitInputFormat('https://cos/x/a.webp')
    expect(r.image).toBeNull()
    expect(r.error).toMatch(/PNG \/ JPEG/)
  })

  it('环境不支持转码时给可操作的提示，不是静默失败', async () => {
    g.fetch = undefined
    const r = await ensureLayerSplitInputFormat('https://cos/x/a.webp')
    expect(r.image).toBeNull()
    expect(r.error).toMatch(/无法转码/)
  })

  it('空输入直接拦下', async () => {
    installTranscodeEnv()
    const r = await ensureLayerSplitInputFormat('')
    expect(r.image).toBeNull()
    expect(r.error).toMatch(/需要一张/)
  })
})
