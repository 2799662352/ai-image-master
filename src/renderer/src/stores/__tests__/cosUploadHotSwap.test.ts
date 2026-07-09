import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ApiActions } from '../../hooks/useService'

/**
 * P0 OOM 回归测试 (2026-06-23, 契约更新于 2026-07-09):
 *
 * 现象: 用户生成图片有几率卡死黑屏, 4K 更频繁, 持续运转 ~30 分钟必现。
 *
 * 根因: 每张生成图的「模型直出 base64」(`useGenerateStore.resultUrls[i]` /
 * `useBatchStore.items[i].resultUrl`)一整次会话都驻留在 zustand state 里,
 * COS 持久化完成后从不释放。4K 一张 base64 ≈ 10MB 字符串 + blob + 解码位图,
 * 上限 200 条 ≈ 2GB 堆 → 渲染进程内存耗尽黑屏。
 *
 * 当前契约 (2026-07-09 P0 闪退修复后):
 *   ① data: base64 在进 store 前就被 materializeImageUrls 物化成 blob: URL
 *      (底层字节进堆外 Blob), store 里从头到尾不驻留巨型字符串;
 *   ② COS 上传成功后展示 URL 热切到轻量 cosUrl(http), blob: 被 revoke;
 *   ③ 上传失败时保留 blob: 兜底显示(cosUrl 不存在时唯一可显示源)。
 *
 * 注意 (jsdom realm 陷阱): node fetch 产出的是 undici Blob, 与 jsdom 的
 * FileReader 不同 realm — 老 preload 的 readAsDataURL 降级通道在测试里会炸。
 * fake bridge 必须提供 enqueueUploadBytes(现代 preload 的字节通道)。
 */

type CosResult =
  | { requestId: string; success: true; url: string; key: string }
  | { requestId: string; success: false; error: string }

let emit: ((r: CosResult) => void) | null = null

function installBridge(): void {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    cos: {
      enqueueUploadFromUrl: () => Promise.resolve({ queued: true }),
      // 字节通道必须存在: 没有它 enqueueCosUploadBlob 会走 FileReader 降级,
      // 在 jsdom 里对 undici Blob 抛 TypeError, 把 batch item 打成 error。
      enqueueUploadBytes: () => Promise.resolve({ queued: true }),
      onUploadResult: (cb: (r: CosResult) => void) => {
        emit = cb
        return () => {
          emit = null
        }
      },
    },
  }
}

// 一张「重」图: data: 前缀 + 足够长的主体, 模拟 4K base64。
const BIG_BASE64 = 'data:image/png;base64,' + 'A'.repeat(2000)
const COS_URL = 'https://cos.example.com/image-history/2026/x.png'

function mockApi(): ApiActions {
  return {
    generateImage: vi.fn().mockResolvedValue({ success: true, urls: [BIG_BASE64] }),
  } as unknown as ApiActions
}

describe('COS upload hot-swap frees model base64 (P0 OOM fix)', () => {
  beforeEach(() => {
    vi.resetModules()
    emit = null
    installBridge()
  })

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    vi.restoreAllMocks()
  })

  it('generate store: resultUrls[i] hot-swaps to cosUrl after upload, dropping base64', async () => {
    const { useGenerateStore, initialState } = await import('../useGenerateStore')
    useGenerateStore.setState({ ...initialState })

    await useGenerateStore.getState().generate(mockApi(), 'nano-banana')

    // 上传前: base64 已在进 store 前物化成 blob: URL(堆外), 展示用它兜底。
    expect(useGenerateStore.getState().resultUrls[0]).toMatch(/^blob:/)
    const meta = useGenerateStore.getState().resultMeta[0]
    expect(emit).toBeTruthy()

    emit!({ requestId: `generate:${meta.id}`, success: true, url: COS_URL, key: 'k' })

    const st = useGenerateStore.getState()
    expect(st.resultMeta[0].uploadStatus).toBe('uploaded')
    expect(st.resultMeta[0].cosUrl).toBe(COS_URL)
    // 关键不变量: 展示 URL 热切到轻量 cosUrl, blob: 被换下(随后 revoke)
    expect(st.resultUrls[0]).toBe(COS_URL)
  })

  it('batch store: item.resultUrl is freed after successful upload', async () => {
    const { useBatchStore, initialState } = await import('../useBatchStore')
    useBatchStore.setState({ ...initialState })

    useBatchStore.getState().addItem('a cat')
    await useBatchStore.getState().runBatch(mockApi(), 'nano-banana', {
      idleExitMs: 0,
      concurrency: 1,
    })

    const item = useBatchStore.getState().items[0]
    expect(item.status).toBe('done')
    // base64 已物化: store 里只有几十字节的 blob: URL
    expect(item.resultUrl).toMatch(/^blob:/)
    expect(emit).toBeTruthy()

    emit!({ requestId: `batch:${item.id}`, success: true, url: COS_URL, key: 'k' })

    const after = useBatchStore.getState().items[0]
    expect(after.uploadStatus).toBe('uploaded')
    expect(after.cosUrl).toBe(COS_URL)
    // 关键不变量: 上传成功后临时展示源被释放(blob 随后 revoke)
    expect(after.resultUrl).toBeUndefined()
  })

  it('batch store: failed upload keeps base64 as fallback', async () => {
    const { useBatchStore, initialState } = await import('../useBatchStore')
    useBatchStore.setState({ ...initialState })

    useBatchStore.getState().addItem('a dog')
    await useBatchStore.getState().runBatch(mockApi(), 'nano-banana', {
      idleExitMs: 0,
      concurrency: 1,
    })
    const item = useBatchStore.getState().items[0]

    emit!({ requestId: `batch:${item.id}`, success: false, error: 'network down' })

    const after = useBatchStore.getState().items[0]
    expect(after.uploadStatus).toBe('failed')
    // 失败时 cosUrl 不存在, 必须保留 blob: 兜底显示(它是唯一可显示源)
    expect(after.resultUrl).toBe(item.resultUrl)
    expect(after.resultUrl).toMatch(/^blob:/)
  })
})
