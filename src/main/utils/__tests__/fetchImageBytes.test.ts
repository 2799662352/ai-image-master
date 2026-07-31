import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
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

/**
 * 造一个 body 为 web ReadableStream 的假响应。
 *
 * 用 `Readable.toWeb` 是刻意的 —— Electron 自己的 net.fetch 实现就是这么造
 * response body 的(`lib/browser/api/net-fetch.ts`),Node 的 undici fetch 同理。
 * 保真度对得上,测的才是真实形状。
 */
function streamResponse(
  chunks: string[],
  opts: { status?: number; contentType?: string } = {},
): Response {
  const status = opts.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? (opts.contentType ?? null) : null),
    },
    body: Readable.toWeb(Readable.from(chunks.map((c) => Buffer.from(c)))),
  } as unknown as Response
}

describe('fetchImageToFile — 流式落盘', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fi-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('流式写入并原子落位,带回 content-type', async () => {
    const { fetchImageToFile } = await import('../fetchImageBytes')
    const dest = path.join(tmpDir, 'a.png')
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(streamResponse(['abc', 'de'], { contentType: 'image/webp' }))

    const res = await fetchImageToFile('https://cdn/a.png', dest, { fetchImpl, delayMs: 0 })

    expect(res).toMatchObject({ ok: true, path: dest, bytes: 5, contentType: 'image/webp' })
    expect(await fs.readFile(dest, 'utf8')).toBe('abcde')
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  // 错误分类必须与 fetchImageBytes 完全一致 —— 那是全仓库做得最细的一处,
  // 流式化不该把它冲淡。
  it('403 立刻放弃,不重试', async () => {
    const { fetchImageToFile } = await import('../fetchImageBytes')
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([], { status: 403 }))

    const res = await fetchImageToFile('https://cdn/a.png', path.join(tmpDir, 'b.png'), {
      fetchImpl,
      delayMs: 0,
    })

    expect(res).toEqual({ ok: false, error: 'fetch 403' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('503 重试,第二次成功', async () => {
    const { fetchImageToFile } = await import('../fetchImageBytes')
    const dest = path.join(tmpDir, 'c.png')
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([], { status: 503 }))
      .mockResolvedValueOnce(streamResponse(['ok'], { contentType: 'image/png' }))

    const res = await fetchImageToFile('https://cdn/a.png', dest, { fetchImpl, delayMs: 0 })

    expect(res.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('空响应体判失败,且不留下文件', async () => {
    const { fetchImageToFile } = await import('../fetchImageBytes')
    const dest = path.join(tmpDir, 'd.png')
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([], { contentType: 'image/png' }))

    const res = await fetchImageToFile('https://cdn/a.png', dest, {
      fetchImpl,
      delayMs: 0,
      attempts: 1,
    })

    expect(res.ok).toBe(false)
    await expect(fs.access(dest)).rejects.toThrow()
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  it('传输中途出错时清理 .part,并按重试策略再来一次', async () => {
    const { fetchImageToFile } = await import('../fetchImageBytes')
    const dest = path.join(tmpDir, 'e.png')
    const brokenBody = Readable.toWeb(
      new Readable({
        read() {
          this.push(Buffer.from('half'))
          this.destroy(new Error('socket hang up'))
        },
      }),
    )
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        body: brokenBody,
      } as unknown as Response)
      .mockResolvedValueOnce(streamResponse(['whole'], { contentType: 'image/png' }))

    const res = await fetchImageToFile('https://cdn/a.png', dest, { fetchImpl, delayMs: 0 })

    expect(res.ok).toBe(true)
    expect(await fs.readFile(dest, 'utf8')).toBe('whole')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
