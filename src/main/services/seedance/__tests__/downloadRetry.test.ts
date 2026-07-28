import { describe, expect, it, vi } from 'vitest'
import { retryDownload } from '../downloadRetry'

/**
 * 视频落盘只有这一次机会。
 *
 * 失败了不会有第二轮:任务此刻就落 persistence='failed',本地没有、COS 也没有,
 * 只剩上游那条一天后过期的地址。而原来的重试是「连试两次、间隔为零」—— 一次
 * 几秒的网络抖动正好把两次一起吃掉。退避的意义就在这儿:把两次尝试岔开到抖动
 * 窗口之外,而不是在同一秒里撞两次墙。
 */
describe('retryDownload', () => {
  it('第一次就成功时不等待、不重试', async () => {
    const attempt = vi.fn(async () => 'bytes')
    const sleep = vi.fn(async () => {})

    expect(await retryDownload(attempt, { attempts: 3, delayMs: 1000, sleep })).toBe('bytes')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('失败后按递增退避重试,直到成功', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue('bytes')
    const waited: number[] = []
    const sleep = vi.fn(async (ms: number) => { waited.push(ms) })

    expect(await retryDownload(attempt, { attempts: 3, delayMs: 1000, sleep })).toBe('bytes')
    expect(attempt).toHaveBeenCalledTimes(3)
    // 岔开:第二次等 1s,第三次等 2s —— 而不是原来的「零间隔连撞两次」。
    expect(waited).toEqual([1000, 2000])
  })

  it('次数用尽后抛出最后一次的原因', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('socket hang up'))
    const sleep = vi.fn(async () => {})

    await expect(retryDownload(attempt, { attempts: 3, delayMs: 10, sleep }))
      .rejects.toThrow('socket hang up')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('把非 Error 的抛出物也包成 Error,调用方能拿到可读原因', async () => {
    const attempt = vi.fn().mockRejectedValue('plain string boom')
    const sleep = vi.fn(async () => {})

    await expect(retryDownload(attempt, { attempts: 2, delayMs: 0, sleep }))
      .rejects.toThrow('plain string boom')
  })
})
