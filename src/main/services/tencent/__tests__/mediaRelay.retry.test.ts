// @vitest-environment node
//
// 中转上传的失败语义。这条链路是「用户按了生成」的前置步骤,一次网络抖动就废掉
// 整张卡片,代价远高于多等几秒 —— 所以瞬时失败要自动重试;而失败最终透出时必须
// 是一条带真实原因的 Error,不能是 SDK 那个渲成 [object Object] 的裸对象。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const uploadBufferToBucket = vi.fn()
const uploadStreamToBucket = vi.fn()

vi.mock('../cosClient', () => ({
  uploadBufferToBucket: (...args: unknown[]) => uploadBufferToBucket(...args),
  uploadStreamToBucket: (...args: unknown[]) => uploadStreamToBucket(...args),
}))

// 重试之间的等待是真 setTimeout,用假计时器把它压掉,否则每个用例白等 2.4 秒。
beforeEach(() => {
  vi.useFakeTimers()
  uploadBufferToBucket.mockReset()
  uploadStreamToBucket.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 跑一个带重试的调用:边推进假时钟边等,直到 promise settle。
 *
 * 必须**先**挂上 handler 再推时钟 —— 否则重试用尽后的那次 reject 还没有任何
 * handler,Vitest 会把它记成 unhandled rejection,即使每条断言都通过也把整轮判失败。
 */
async function runWithTimers<T>(start: () => Promise<T>): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined
  const settled = start().then(
    (value) => {
      outcome = { ok: true, value }
    },
    (error) => {
      outcome = { ok: false, error }
    },
  )
  // 每轮把挂起的定时器推完,让重试立刻进入下一次尝试。
  for (let i = 0; i < 8 && !outcome; i++) {
    await vi.runAllTimersAsync()
  }
  await settled
  if (!outcome) throw new Error('runWithTimers: 调用始终没有结束')
  if (outcome.ok) return outcome.value
  throw outcome.error
}

describe('relayRetryDelayMs — 指数退避 + 等量抖动', () => {
  it('随尝试次数指数增长,并封顶', async () => {
    const { relayRetryDelayMs } = await import('../mediaRelay')
    const mid = () => 0.5
    // 500 → 1000 → 2000 …,等量抖动下 random=0.5 恰好取到 0.75 倍上限。
    expect(relayRetryDelayMs(1, mid)).toBe(375)
    expect(relayRetryDelayMs(2, mid)).toBe(750)
    expect(relayRetryDelayMs(3, mid)).toBe(1500)
    // 封顶 8s:再多的尝试也不会把用户吊在那儿。
    expect(relayRetryDelayMs(20, mid)).toBe(6000)
    expect(relayRetryDelayMs(20, () => 1)).toBe(8000)
  })

  it('等量抖动:保底一半间隔,但不同调用会错开', async () => {
    const { relayRetryDelayMs } = await import('../mediaRelay')
    // 满抖动可能给出接近 0 的等待,三次尝试一瞬间烧完;这里保底 250ms。
    expect(relayRetryDelayMs(1, () => 0)).toBe(250)
    expect(relayRetryDelayMs(1, () => 1)).toBe(500)
    const spread = new Set([0.1, 0.4, 0.9].map((r) => relayRetryDelayMs(2, () => r)))
    expect(spread.size).toBe(3)
  })
})

describe('relayBufferToCos', () => {
  it('瞬时失败自动重试,后续成功就当没事发生', async () => {
    const { relayBufferToCos } = await import('../mediaRelay')
    uploadBufferToBucket
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockResolvedValueOnce('https://bucket.cos.ap-guangzhou.myqcloud.com/image-history/a.jpg')

    const url = await runWithTimers(() => relayBufferToCos(Buffer.from('x'), 'image/jpeg'))

    expect(url).toContain('image-history/')
    expect(uploadBufferToBucket).toHaveBeenCalledTimes(2)
  })

  it('鉴权类失败不重试 —— 立刻把原因还给用户', async () => {
    const { relayBufferToCos } = await import('../mediaRelay')
    uploadBufferToBucket.mockRejectedValue({
      code: 'AccessDenied',
      statusCode: 403,
      message: 'Access Denied.',
    })

    await expect(
      runWithTimers(() => relayBufferToCos(Buffer.from('x'), 'image/jpeg')),
    ).rejects.toThrow(/AccessDenied/)
    expect(uploadBufferToBucket).toHaveBeenCalledTimes(1)
  })

  it('重试用尽后抛的是真 Error,消息里有真实原因而不是 [object Object]', async () => {
    const { relayBufferToCos } = await import('../mediaRelay')
    uploadBufferToBucket.mockRejectedValue({
      code: 'RequestError',
      error: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND cos.ap-guangzhou.myqcloud.com' },
    })

    const error = await runWithTimers(() =>
      relayBufferToCos(Buffer.from('x'), 'image/jpeg'),
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('[object Object]')
    expect((error as Error).message).toContain('ENOTFOUND')
    expect(uploadBufferToBucket).toHaveBeenCalledTimes(3)
  })

  it('每次重试换一个 Key —— 别让上一次的分片残留干扰下一次', async () => {
    const { relayBufferToCos } = await import('../mediaRelay')
    uploadBufferToBucket
      .mockRejectedValueOnce({ statusCode: 500 })
      .mockResolvedValueOnce('https://bucket/ok')

    await runWithTimers(() => relayBufferToCos(Buffer.from('x'), 'image/jpeg'))

    const keys = uploadBufferToBucket.mock.calls.map((c) => (c[0] as { key: string }).key)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
    // STS 票据只授权 image-history/ 前缀,换 Key 也不能换出这个前缀。
    for (const key of keys) expect(key.startsWith('image-history/')).toBe(true)
  })

  it('空 buffer 直接拒,不浪费一次网络往返', async () => {
    const { relayBufferToCos } = await import('../mediaRelay')
    await expect(relayBufferToCos(Buffer.alloc(0), 'image/jpeg')).rejects.toThrow(/empty buffer/)
    expect(uploadBufferToBucket).not.toHaveBeenCalled()
  })
})

describe('relayFileToCos', () => {
  it('走流式上传并按体积放大总时长保险丝(大文件不该被固定超时掐断)', async () => {
    const { relayFileToCos } = await import('../mediaRelay')
    uploadStreamToBucket.mockResolvedValue('https://bucket/ok')

    const fileSize = 2 * 1024 * 1024 * 1024 // 2GB
    await relayFileToCos('D:\\clips\\hero.mp4', 'video/mp4', { fileSize })

    const opts = uploadStreamToBucket.mock.calls[0][0] as {
      filePath: string
      hardTimeoutMs: number
    }
    expect(opts.filePath).toBe('D:\\clips\\hero.mp4')
    expect(opts.hardTimeoutMs).toBeGreaterThan(15 * 60 * 1000)
  })

  it('Key 用文件自己的扩展名,不靠 mime 反查 —— 反查表漏掉的类型会变成 .bin', async () => {
    const { relayFileToCos } = await import('../mediaRelay')
    uploadStreamToBucket.mockResolvedValue('https://bucket/ok')

    await relayFileToCos('D:\\clips\\hero.MKV', 'application/octet-stream')

    const key = (uploadStreamToBucket.mock.calls[0][0] as { key: string }).key
    expect(key.endsWith('.mkv')).toBe(true)
    expect(key.startsWith('image-history/')).toBe(true)
  })

  it('流式上传同样享受重试', async () => {
    const { relayFileToCos } = await import('../mediaRelay')
    uploadStreamToBucket
      .mockRejectedValueOnce(new Error('sliceUploadFile timeout'))
      .mockResolvedValueOnce('https://bucket/ok')

    const url = await runWithTimers(() => relayFileToCos('D:\\clips\\hero.mp4', 'video/mp4'))

    expect(url).toBe('https://bucket/ok')
    expect(uploadStreamToBucket).toHaveBeenCalledTimes(2)
  })
})
