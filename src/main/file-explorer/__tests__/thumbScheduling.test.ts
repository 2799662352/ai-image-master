/**
 * thumbScheduling —— `media:thumb` 的限并发执行器与按字节封顶的 LRU 缓存。
 */
import { describe, expect, it } from 'vitest'
import { createByteLru, createLimiter } from '../thumbScheduling'

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createLimiter', () => {
  it('同时运行的任务数不超过上限,其余按到达顺序排队', async () => {
    const run = createLimiter(2)
    const gates = Array.from({ length: 5 }, () => deferred())
    const started: number[] = []
    const results = gates.map((g, i) =>
      run(async () => {
        started.push(i)
        await g.promise
        return i
      }),
    )
    await Promise.resolve()
    expect(started).toEqual([0, 1])
    gates[0].resolve()
    await results[0]
    expect(started).toEqual([0, 1, 2])
    gates[1].resolve()
    gates[2].resolve()
    await Promise.all([results[1], results[2]])
    expect(started).toEqual([0, 1, 2, 3, 4])
    gates[3].resolve()
    gates[4].resolve()
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4])
  })

  it('任务失败(异步 reject / 同步抛错)也归还名额,不堵住后面的', async () => {
    const run = createLimiter(1)
    const a = run(async () => {
      throw new Error('async boom')
    })
    const b = run(() => {
      throw new Error('sync boom')
    })
    const c = run(async () => 'ok')
    await expect(a).rejects.toThrow('async boom')
    await expect(b).rejects.toThrow('sync boom')
    await expect(c).resolves.toBe('ok')
  })

  it('上限小于 1 / 非整数时按 1 处理,不会死锁', async () => {
    const run = createLimiter(0)
    await expect(Promise.all([run(async () => 1), run(async () => 2)])).resolves.toEqual([1, 2])
  })
})

describe('createByteLru', () => {
  it('超出字节预算时丢最久没用的', () => {
    const lru = createByteLru<string>(10)
    lru.set('a', 'A', 4)
    lru.set('b', 'B', 4)
    lru.set('c', 'C', 4) // 12 > 10 → 丢 a
    expect(lru.get('a')).toBeUndefined()
    expect(lru.get('b')).toBe('B')
    expect(lru.get('c')).toBe('C')
    expect(lru.bytes).toBe(8)
    expect(lru.size).toBe(2)
  })

  it('读一次就算最近用过', () => {
    const lru = createByteLru<string>(10)
    lru.set('a', 'A', 4)
    lru.set('b', 'B', 4)
    expect(lru.get('a')).toBe('A') // a 变成最近
    lru.set('c', 'C', 4) // 丢最久没用的 = b
    expect(lru.get('b')).toBeUndefined()
    expect(lru.get('a')).toBe('A')
    expect(lru.get('c')).toBe('C')
  })

  it('同一个 key 重复写:字节数按新值算,不累加', () => {
    const lru = createByteLru<string>(10)
    lru.set('a', 'A1', 6)
    lru.set('a', 'A2', 3)
    expect(lru.bytes).toBe(3)
    expect(lru.size).toBe(1)
    expect(lru.get('a')).toBe('A2')
  })

  it('单条就超过总预算:不缓存,也不把已有的挤掉', () => {
    const lru = createByteLru<string>(10)
    lru.set('a', 'A', 4)
    lru.set('huge', 'H', 11)
    expect(lru.get('huge')).toBeUndefined()
    expect(lru.get('a')).toBe('A')
    expect(lru.bytes).toBe(4)
  })

  it('正好等于预算不算超:多条合计 = 预算时都留着,单条 = 预算也缓存', () => {
    const lru = createByteLru<string>(10)
    lru.set('a', 'A', 5)
    lru.set('b', 'B', 5)
    expect(lru.get('a')).toBe('A')
    expect(lru.get('b')).toBe('B')
    expect(lru.bytes).toBe(10)
    lru.clear()
    lru.set('whole', 'W', 10)
    expect(lru.get('whole')).toBe('W')
  })

  it('clear 清空条目与字节计数', () => {
    const lru = createByteLru<string>(10)
    lru.set('a', 'A', 4)
    lru.clear()
    expect(lru.size).toBe(0)
    expect(lru.bytes).toBe(0)
    expect(lru.get('a')).toBeUndefined()
  })
})