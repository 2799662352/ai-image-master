import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ApiActions } from '../../hooks/useService'

/**
 * P0 OOM 回归测试 (2026-06-23):
 *
 * 现象: 用户生成图片有几率卡死黑屏, 4K 更频繁, 持续运转 ~30 分钟必现。
 *
 * 根因: 每张生成图的「模型直出 base64」(`useGenerateStore.resultUrls[i]` /
 * `useBatchStore.items[i].resultUrl`)一整次会话都驻留在 zustand state 里,
 * COS 持久化完成后从不释放。4K 一张 base64 ≈ 10MB 字符串 + blob + 解码位图,
 * 上限 200 条 ≈ 2GB 堆 → 渲染进程内存耗尽黑屏。
 *
 * 修复: 上传成功后把展示 URL 热切到轻量 cosUrl(http), 释放 base64。
 * 这两条测试锁死「上传成功后 base64 必须被释放」这一不变量。
 */

type CosResult =
  | { requestId: string; success: true; url: string; key: string }
  | { requestId: string; success: false; error: string }

let emit: ((r: CosResult) => void) | null = null

function installBridge(): void {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    cos: {
      enqueueUploadFromUrl: () => Promise.resolve({ queued: true }),
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

    // 上传前: 展示用的是模型直出 base64 (临时)
    expect(useGenerateStore.getState().resultUrls[0]).toBe(BIG_BASE64)
    const meta = useGenerateStore.getState().resultMeta[0]
    expect(emit).toBeTruthy()

    emit!({ requestId: `generate:${meta.id}`, success: true, url: COS_URL, key: 'k' })

    const st = useGenerateStore.getState()
    expect(st.resultMeta[0].uploadStatus).toBe('uploaded')
    expect(st.resultMeta[0].cosUrl).toBe(COS_URL)
    // 关键不变量: resultUrls 不再持有重型 base64
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
    expect(item.resultUrl).toBe(BIG_BASE64)
    expect(emit).toBeTruthy()

    emit!({ requestId: `batch:${item.id}`, success: true, url: COS_URL, key: 'k' })

    const after = useBatchStore.getState().items[0]
    expect(after.uploadStatus).toBe('uploaded')
    expect(after.cosUrl).toBe(COS_URL)
    // 关键不变量: 上传成功后 base64 被释放
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
    // 失败时 cosUrl 不存在, 必须保留 base64 兜底显示
    expect(after.resultUrl).toBe(BIG_BASE64)
  })
})
