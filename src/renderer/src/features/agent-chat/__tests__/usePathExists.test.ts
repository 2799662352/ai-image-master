// 缓存的生命周期契约。
//
// VS Code Copilot Chat 的 StatCache 是每次响应一个、随响应丢掉 —— 生命周期恰好
// 等于那次计算的作用域。我们因为 React 会反复重渲染而改成模块级长活缓存,于是
// 「什么时候该重新验证」这个责任落到自己头上,两个方向都要管:文件后来才被创建
// (否定要过期)、文件后来被删掉(肯定也要过期)。第二条第一版漏了。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetPathExistsCache, verifyPathExists } from '../usePathExists'

const PATH = 'D:\\proj\\src\\a.ts'

let stat: ReturnType<typeof vi.fn>

beforeEach(() => {
  __resetPathExistsCache()
  vi.useFakeTimers()
  stat = vi.fn(async () => ({ ok: true }))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { fs: { stat } }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('verifyPathExists', () => {
  it('同一路径只问一次磁盘', async () => {
    expect(await verifyPathExists(PATH)).toBe(true)
    expect(await verifyPathExists(PATH)).toBe(true)
    expect(stat).toHaveBeenCalledTimes(1)
  })

  it('并发请求合成一次(在途去重)', async () => {
    const [a, b] = await Promise.all([verifyPathExists(PATH), verifyPathExists(PATH)])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(stat).toHaveBeenCalledTimes(1)
  })

  it('失败也缓存 —— 绝大多数候选都不是文件,这是最常走的一条路', async () => {
    stat.mockResolvedValue({ ok: false })
    expect(await verifyPathExists(PATH)).toBe(false)
    expect(await verifyPathExists(PATH)).toBe(false)
    expect(stat).toHaveBeenCalledTimes(1)
  })

  it('否定结果 15 秒后重新核 —— agent 建好文件时 stat 可能跑在写盘之前', async () => {
    stat.mockResolvedValue({ ok: false })
    expect(await verifyPathExists(PATH)).toBe(false)

    vi.advanceTimersByTime(16_000)
    stat.mockResolvedValue({ ok: true })
    expect(await verifyPathExists(PATH)).toBe(true)
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('肯定结果 60 秒后也重新核 —— 否则文件被删了还照样标蓝', async () => {
    expect(await verifyPathExists(PATH)).toBe(true)

    // 一分钟内不重复问
    vi.advanceTimersByTime(30_000)
    expect(await verifyPathExists(PATH)).toBe(true)
    expect(stat).toHaveBeenCalledTimes(1)

    // 过期后重新核,这次文件已经没了
    vi.advanceTimersByTime(31_000)
    stat.mockResolvedValue({ ok: false })
    expect(await verifyPathExists(PATH)).toBe(false)
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('没有 fs 桥时一律当不存在,不抛错', async () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {}
    expect(await verifyPathExists(PATH)).toBe(false)
  })

  it('stat 抛错当不存在', async () => {
    stat.mockRejectedValue(new Error('boom'))
    expect(await verifyPathExists(PATH)).toBe(false)
  })
})
