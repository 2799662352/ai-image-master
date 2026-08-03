// @vitest-environment node
//
// 中转上传的全局并发闸。
//
// 为什么需要这道闸:工作台 `startCards` 对卡片是无上限的 `Promise.all`,每张卡
// 内部还要传若干素材,乘起来轻易几十个并发 PutObject。仓库里另外两道 COS 闸都
// 够不到这条路 —— 主进程那个 12 槽只包住 `enqueueUpload()`,渲染层那个 4 槽在
// 另一个进程里。所以 mediaRelay 必须自带一道。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const uploadBufferToBucket = vi.fn()
const uploadStreamToBucket = vi.fn()
const clearStsCache = vi.fn()

vi.mock('../cosClient', () => ({
  uploadBufferToBucket: (...args: unknown[]) => uploadBufferToBucket(...args),
  uploadStreamToBucket: (...args: unknown[]) => uploadStreamToBucket(...args),
}))

vi.mock('../stsCredentials', () => ({
  clearStsCache: (...args: unknown[]) => clearStsCache(...args),
}))

const { relayBufferToCos, MAX_CONCURRENT_RELAYS, __resetRelayConcurrencyForTests } = await import(
  '../mediaRelay'
)

/** 一个可以从外部决定何时完成的 upload stub。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  uploadBufferToBucket.mockReset()
  uploadStreamToBucket.mockReset()
  clearStsCache.mockReset()
  __resetRelayConcurrencyForTests()
})

afterEach(() => {
  vi.useRealTimers()
  __resetRelayConcurrencyForTests()
})

describe('mediaRelay 并发闸', () => {
  it('同时最多只放行 MAX_CONCURRENT_RELAYS 个上传', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_RELAYS + 2 }, () => deferred<string>())
    let started = 0
    uploadBufferToBucket.mockImplementation(() => {
      const gate = gates[started]
      started += 1
      return gate.promise
    })

    const runs = gates.map((_, i) =>
      relayBufferToCos(Buffer.from(`payload-${i}`), 'image/png').catch(() => 'failed'),
    )

    // 让已放行的调用真正进入 uploadBufferToBucket。
    await Promise.resolve()
    await Promise.resolve()

    expect(started).toBe(MAX_CONCURRENT_RELAYS)

    // 放掉一个,队首才被放进来。
    gates[0].resolve('https://cos/0.png')
    await gates[0].promise
    await Promise.resolve()
    await Promise.resolve()

    expect(started).toBe(MAX_CONCURRENT_RELAYS + 1)

    for (let i = 1; i < gates.length; i++) gates[i].resolve(`https://cos/${i}.png`)
    await Promise.all(runs)
  })

  it('上传失败也释放槽位,不泄漏', async () => {
    // 确定性失败(非可重试)会直接放弃,正好用来检查 finally 释放。
    uploadBufferToBucket.mockRejectedValue(
      Object.assign(new Error('AccessDenied'), { code: 'AccessDenied', statusCode: 403 }),
    )

    const failures = Array.from({ length: MAX_CONCURRENT_RELAYS + 3 }, (_, i) =>
      relayBufferToCos(Buffer.from(`x-${i}`), 'image/png').catch(() => 'failed'),
    )
    const results = await Promise.all(failures)

    // 全部走完 = 槽位被正确归还;泄漏的话后面几个会永久挂起,这里会超时。
    expect(results).toHaveLength(MAX_CONCURRENT_RELAYS + 3)
    expect(results.every((r) => r === 'failed')).toBe(true)
  })

  it('槽位覆盖整个重试周期 —— 退避等待期间不放行新请求', async () => {
    vi.useFakeTimers()
    const flaky = Object.assign(new Error('boom'), { statusCode: 503 })
    let firstCallCount = 0
    const secondStarted = { value: false }

    uploadBufferToBucket.mockImplementation((args: { body: Buffer }) => {
      if (args.body.toString() === 'first') {
        firstCallCount += 1
        // 第一次失败 → 进入退避等待。
        return firstCallCount === 1 ? Promise.reject(flaky) : Promise.resolve('https://cos/first')
      }
      secondStarted.value = true
      return Promise.resolve('https://cos/second')
    })

    // 闸设成 1 才能观察到「退避期间是否放行」。用满槽位模拟:先占掉 MAX-1 个。
    const holders = Array.from({ length: MAX_CONCURRENT_RELAYS - 1 }, () => deferred<string>())
    let held = 0
    const holderRuns = holders.map(() => {
      const gate = holders[held]
      held += 1
      uploadBufferToBucket.mockImplementationOnce(() => gate.promise)
      return relayBufferToCos(Buffer.from('hold'), 'image/png').catch(() => 'failed')
    })
    await Promise.resolve()

    const firstRun = relayBufferToCos(Buffer.from('first'), 'image/png').catch(() => 'failed')
    await Promise.resolve()
    await Promise.resolve()

    const secondRun = relayBufferToCos(Buffer.from('second'), 'image/png').catch(() => 'failed')
    await Promise.resolve()
    await Promise.resolve()

    // first 正在退避等待,它仍占着槽位 → second 不该开始。
    expect(secondStarted.value).toBe(false)

    await vi.runAllTimersAsync()
    for (const h of holders) h.resolve('https://cos/hold')
    await Promise.all([...holderRuns, firstRun, secondRun])

    expect(secondStarted.value).toBe(true)
  })
})
