import { describe, expect, it, vi } from 'vitest'
import { fetchImageBytes } from '../fetchImageBytes'

/**
 * 转存那一次 fetch 必须扛得住抖动。
 *
 * 生成结果先以模型直出的临时 URL 展示,主进程随后把字节抓回来落本地盘、再推
 * COS。本地副本是在这次 fetch **之后**才写的,所以这一次失败就是双重失败:
 * 既没有本地副本也没有 COS 副本,history 只能退回那条几小时后过期的预签名
 * URL —— 一次瞬时抖动埋下一颗第二天才炸的雷。
 *
 * 但只对"可能自愈"的失败重试:403(签名过期)、404 重试多少次都一样,徒增等待。
 */

function okResponse(bytes: number[], contentType?: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType ?? null : null) },
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as unknown as Response
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response
}

describe('fetchImageBytes', () => {
  it('一次拿到就不重试,并带回 content-type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([1, 2, 3], 'image/webp'))

    const result = await fetchImageBytes('https://cdn/a.png', { fetchImpl, delayMs: 0 })

    expect(result).toMatchObject({ ok: true, contentType: 'image/webp' })
    expect(result.ok && result.body.length).toBe(3)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('连接被掐断后重试并成功', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(okResponse([7], 'image/png'))

    const result = await fetchImageBytes('https://cdn/a.png', { fetchImpl, delayMs: 0 })

    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('上游 5xx / 429 也重试', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValue(okResponse([9], 'image/png'))

    const result = await fetchImageBytes('https://cdn/a.png', {
      fetchImpl,
      delayMs: 0,
      attempts: 3,
    })

    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('403 不重试 —— 签名过期再试一百次也是过期', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(403))

    const result = await fetchImageBytes('https://cdn/a.png', { fetchImpl, delayMs: 0 })

    expect(result).toEqual({ ok: false, error: 'fetch 403' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('空响应体算失败,不会把 0 字节当成图存下来', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([], 'image/png'))

    const result = await fetchImageBytes('https://cdn/a.png', { fetchImpl, delayMs: 0, attempts: 1 })

    expect(result.ok).toBe(false)
  })

  it('次数用尽后报出最后一次的原因', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('socket hang up'))

    const result = await fetchImageBytes('https://cdn/a.png', {
      fetchImpl,
      delayMs: 0,
      attempts: 3,
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('socket hang up')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('每次尝试都带自己的超时信号', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([1], 'image/png'))

    await fetchImageBytes('https://cdn/a.png', { fetchImpl, delayMs: 0 })

    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)
  })
})
