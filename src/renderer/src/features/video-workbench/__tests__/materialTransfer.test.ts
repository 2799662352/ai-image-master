import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isTransferableMaterialSrc,
  resetMaterialTransfersForTest,
  startMaterialTransfer,
} from '../materialTransfer'

/**
 * 挂进工作台的外链图要转存成我们自己的地址。
 *
 * 根因不在渲染:`materialThumbTarget` 对图片素材直接返回 `src`,
 * `useResolvedMediaSrc` 对非本地路径原样透传,所以 `<img src="https://…">`
 * 是真挂上去的 —— 加载不出来是因为渲染端**直连第三方图床**,对方慢或不可达
 * (实测 pbs.twimg.com 在本机 curl 同样超时),`onError` 就退回文件名占位。
 *
 * 光修缩略图不够:提交生成时 `resolveMediaUrl` 对 http(s) 也是原样透传给上游,
 * 等于把「这张图能不能用」永久押在第三方服务器上。转存到 COS 之后两头都稳,
 * 而且走的是主进程那条已经带重试的抓取管道。
 */

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/x.png'

describe('isTransferableMaterialSrc', () => {
  it('第三方 http(s) 图链要转存', () => {
    expect(isTransferableMaterialSrc('https://pbs.twimg.com/media/G2ktJBna8AAhgIg?format=jpg')).toBe(true)
    expect(isTransferableMaterialSrc('http://example.com/a.png')).toBe(true)
  })

  it('已经是我们自己的 COS 地址就不再转存 —— 否则每次挂载都白传一份', () => {
    expect(isTransferableMaterialSrc(COS)).toBe(false)
  })

  it('本地路径 / blob: / asset:// 不属于要转存的源', () => {
    expect(isTransferableMaterialSrc('D:\\pics\\cat.png')).toBe(false)
    expect(isTransferableMaterialSrc('blob:app/abc')).toBe(false)
    expect(isTransferableMaterialSrc('asset://a1')).toBe(false)
    expect(isTransferableMaterialSrc('local-file:///D%3A/a.png')).toBe(false)
  })

  // 内联字节(粘贴的图、高级编辑拍平的标注帧)也要转存,理由和外链不同但同样硬:
  // 留着 data: 的话预传(只认本地路径)和转存(只认外链)会双双跳过 —— 于是整段
  // base64 落进 IndexedDB(还要再胖三分之一),提交时 resolveMediaUrl 才发现超
  // 512KB 去中转(那份等待正好落在按下「生成」的一刻),生成后人像库登记又把同一
  // 批字节中转第二遍。换成 https 之后这四件事一起消失。
  it('内联的 data: 图片要转存 —— 它和外链一样不该留在卡片里', () => {
    expect(isTransferableMaterialSrc('data:image/png;base64,AAA')).toBe(true)
    expect(isTransferableMaterialSrc('data:image/jpeg;base64,AAA')).toBe(true)
  })

  // 主进程那条 fire-and-forget 字节通道是**图片专用**的:
  // `cos:enqueue-upload-bytes` 会把非 image/* 的 mime 一律改写成 image/png,
  // 于是一条 mp4 会被存成 .png、带 image/png 的 Content-Type 上 COS,而卡片的
  // src 还被换成那个地址 —— 看着转存成功,实际是一份损坏素材,比不转存糟得多。
  // 视频/音频的内联字节现在原样留着,提交时由 resolveMediaUrl → relayDataUrlToCos
  // 按真实 mime 中转(那条路是 mime 诚实的)。
  it('非图片的 data: 不转存 —— 字节通道会把 mime 改写成 image/png,传上去就是坏素材', () => {
    expect(isTransferableMaterialSrc('data:video/mp4;base64,AAA')).toBe(false)
    expect(isTransferableMaterialSrc('data:audio/mpeg;base64,AAA')).toBe(false)
    expect(isTransferableMaterialSrc('data:application/octet-stream;base64,AAA')).toBe(false)
  })
})

/** 1×1 透明 PNG。 */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface BridgeCalls {
  bytes: Array<{ requestId: string; bytes: ArrayBuffer; mimeType?: string }>
  fromUrl: Array<{ requestId: string; sourceUrl: string }>
}

function installBridge(): BridgeCalls {
  const calls: BridgeCalls = { bytes: [], fromUrl: [] }
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    cos: {
      enqueueUploadBytes: (requestId: string, bytes: ArrayBuffer, mimeType?: string) => {
        calls.bytes.push({ requestId, bytes, mimeType })
        return Promise.resolve({ queued: true })
      },
      enqueueUploadFromUrl: (requestId: string, sourceUrl: string) => {
        calls.fromUrl.push({ requestId, sourceUrl })
        return Promise.resolve({ queued: true })
      },
      onUploadResult: () => () => {},
    },
  }
  return calls
}

describe('startMaterialTransfer', () => {
  afterEach(() => {
    resetMaterialTransfersForTest()
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('data: 素材走字节通道入队,base64 字符串不跨进程', async () => {
    const calls = installBridge()
    startMaterialTransfer(
      { cardId: 'c1', kind: 'referenceImages', originalSrc: PNG_DATA_URL },
      'frame.png',
    )
    await vi.waitFor(() => expect(calls.bytes).toHaveLength(1))
    expect(calls.bytes[0].requestId.startsWith('vwmaterial:')).toBe(true)
    expect(calls.bytes[0].mimeType).toBe('image/png')
    expect(calls.bytes[0].bytes.byteLength).toBeGreaterThan(0)
    // 关键:没有走「把整个 data: 字符串递过去」那条降级通道
    expect(calls.fromUrl).toHaveLength(0)
  })

  it('外链仍走 from-url —— 由主进程去抓,渲染端不碰字节', () => {
    const calls = installBridge()
    startMaterialTransfer(
      { cardId: 'c1', kind: 'referenceImages', originalSrc: 'https://pbs.twimg.com/media/a.jpg' },
      'a.jpg',
    )
    expect(calls.fromUrl).toHaveLength(1)
    expect(calls.bytes).toHaveLength(0)
  })

  it('解不开的 data: 不入队,也不炸 —— 卡片照旧用内联那份', async () => {
    const calls = installBridge()
    startMaterialTransfer(
      { cardId: 'c1', kind: 'referenceImages', originalSrc: 'data:image/png;base64,@@@not-base64' },
      'broken.png',
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.bytes).toHaveLength(0)
    expect(calls.fromUrl).toHaveLength(0)
  })

  it('空值与非字符串一律不转存', () => {
    expect(isTransferableMaterialSrc('')).toBe(false)
    expect(isTransferableMaterialSrc('   ')).toBe(false)
    expect(isTransferableMaterialSrc(undefined as unknown as string)).toBe(false)
  })
})
