// @vitest-environment node
//
// 提交任务的重试判据。这里的每条断言都在守同一件事:createTask 是个**没有幂等键**
// 的 POST,重发一次就可能多一个任务、多一笔钱。所以"哪些错误算安全"不是风格问题,
// 是钱的问题 —— 放宽任何一条之前,先想清楚上游到底有没有可能已经受理。

import { describe, expect, it, vi } from 'vitest'

import { SeedanceApiError } from '../apiError'
import { isSafeToResubmit, retrySubmit, submitRetryDelayMs } from '../submitRetry'

describe('isSafeToResubmit — 只认「上游确定没受理」', () => {
  it('上游回了 429 / 5xx / 408:有响应就说明这轮来回走完了,任务没建成', () => {
    expect(isSafeToResubmit(new SeedanceApiError('rate limited', 429))).toBe(true)
    expect(isSafeToResubmit(new SeedanceApiError('bad gateway', 502))).toBe(true)
    expect(isSafeToResubmit(new SeedanceApiError('request timeout', 408))).toBe(true)
  })

  it('4xx 是请求本身的问题,重发只是把确定的失败推迟', () => {
    expect(isSafeToResubmit(new SeedanceApiError('invalid api key', 401))).toBe(false)
    expect(isSafeToResubmit(new SeedanceApiError('bad resolution', 400))).toBe(false)
  })

  it('连接压根没建起来:请求体从未离开本机,重发绝对安全', () => {
    expect(isSafeToResubmit({ code: 'ECONNREFUSED' })).toBe(true)
    expect(isSafeToResubmit({ code: 'enotfound' })).toBe(true)
    expect(isSafeToResubmit({ cause: { code: 'EAI_AGAIN' } })).toBe(true)
    expect(isSafeToResubmit(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe(true)
    expect(isSafeToResubmit(new Error('request failed: net::ERR_INTERNET_DISCONNECTED'))).toBe(true)
    // TCP 连接超时也在这一类:三次握手都没完成,不可能建出任务。
    expect(isSafeToResubmit(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toBe(true)
  })

  // 下面这组是这个文件存在的真正理由 —— 它们看着都像"网络抖动",但分不清
  // 「上游没收到」和「上游收了、回程丢了」,自动重发就是在赌用户的钱。
  it('连上之后才断的,一律不重发', () => {
    expect(isSafeToResubmit({ code: 'ECONNRESET' })).toBe(false)
    expect(isSafeToResubmit(new Error('socket hang up'))).toBe(false)
    expect(isSafeToResubmit(new Error('net::ERR_CONNECTION_RESET'))).toBe(false)
    expect(isSafeToResubmit(new Error('net::ERR_EMPTY_RESPONSE'))).toBe(false)
  })

  it('我们自己的 30 秒超时不重发', () => {
    expect(isSafeToResubmit(new Error('Seedance API request timed out after 30s'))).toBe(false)
  })

  it('2xx 但响应里没有 task id 更不能重发 —— 那多半意味着任务已经建好了', () => {
    expect(isSafeToResubmit(new Error('Seedance API: create response missing task id'))).toBe(false)
  })

  it('乱七八糟的输入不当成可重试', () => {
    expect(isSafeToResubmit(undefined)).toBe(false)
    expect(isSafeToResubmit(null)).toBe(false)
    expect(isSafeToResubmit('boom')).toBe(false)
  })
})

describe('submitRetryDelayMs — 指数退避 + 等量抖动', () => {
  const mid = (): number => 0.5

  it('随尝试次数指数增长并封顶 6s', () => {
    expect(submitRetryDelayMs(1, undefined, mid)).toBe(600)
    expect(submitRetryDelayMs(2, undefined, mid)).toBe(1200)
    expect(submitRetryDelayMs(3, undefined, mid)).toBe(2400)
    expect(submitRetryDelayMs(20, undefined, mid)).toBe(4500)
    expect(submitRetryDelayMs(20, undefined, () => 1)).toBe(6000)
  })

  it('等量抖动保底一半间隔,但把批量提交错开', () => {
    expect(submitRetryDelayMs(1, undefined, () => 0)).toBe(400)
    const spread = new Set([0.1, 0.4, 0.9].map((r) => submitRetryDelayMs(2, undefined, () => r)))
    expect(spread.size).toBe(3)
  })

  it('上游给了 Retry-After 就听它的,但夹在 [基础间隔, 封顶] 之间', () => {
    expect(submitRetryDelayMs(1, 3_000, mid)).toBe(3_000)
    expect(submitRetryDelayMs(1, 30_000, mid)).toBe(6_000) // 封顶,别把用户吊住
    expect(submitRetryDelayMs(1, 50, mid)).toBe(800) // 太短没意义,抬到基础间隔
  })
})

describe('retrySubmit', () => {
  const instantSleep = vi.fn(async () => undefined)

  it('一次就成的不产生任何等待', async () => {
    const run = vi.fn(async () => 'ok')
    await expect(retrySubmit(run, { sleep: instantSleep })).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('限流后重发,成功了就当没事发生', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new SeedanceApiError('rate limited', 429))
      .mockResolvedValueOnce({ id: 'task-1' })
    await expect(retrySubmit(run, { sleep: instantSleep })).resolves.toEqual({ id: 'task-1' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('ECONNRESET 只试一次 —— 宁可让用户看到失败,也不冒双倍计费', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    await expect(retrySubmit(run, { sleep: instantSleep })).rejects.toThrow(/socket hang up/)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('用尽次数后抛出的仍是原始错误对象,上层的文案翻译才认得出来', async () => {
    const err = new SeedanceApiError('upstream down', 503)
    const run = vi.fn().mockRejectedValue(err)
    await expect(retrySubmit(run, { sleep: instantSleep })).rejects.toBe(err)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('退避听 Retry-After', async () => {
    const sleep = vi.fn(async () => undefined)
    const run = vi
      .fn()
      .mockRejectedValueOnce(new SeedanceApiError('slow down', 429, 2_500))
      .mockResolvedValueOnce('ok')
    await retrySubmit(run, { sleep, random: () => 0.5 })
    expect(sleep).toHaveBeenCalledWith(2_500)
  })
})
