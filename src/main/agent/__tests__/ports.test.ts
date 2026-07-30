// codex app-server 的端口分配。此前整个模块零覆盖,而它正是发布说明里那条
// 「开发版与安装版撞端口」在 codex 侧的落点(`os error 10048`)。
//
// 这里钉的是三件事:选出来的端口确实空着、选择带随机起点(否则两个实例必然同时
// 选中区间第一个)、以及「只对端口冲突重试,其他错误立刻抛」。

import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPortInUseError, pickFreePort, withPortInUseRetry } from '../ports'

const servers: net.Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
})

/** 占住一个由系统分配的端口,返回端口号。用系统分配是为了不跟并行跑的测试抢固定端口。 */
async function occupyPort(): Promise<number> {
  const server = net.createServer()
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as AddressInfo).port
}

describe('pickFreePort', () => {
  it('返回区间内的端口,且真的能绑上', async () => {
    const base = await occupyPort()
    const port = await pickFreePort(base + 1)

    expect(port).toBeGreaterThanOrEqual(base + 1)
    expect(port).toBeLessThan(base + 101)
    // 选出来的必须真能 bind —— 否则这个函数的存在就没有意义
    const probe = net.createServer()
    servers.push(probe)
    await expect(
      new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', () => resolve())
      }),
    ).resolves.toBeUndefined()
  })

  it('绝不返回已被占用的端口', async () => {
    const occupied = await occupyPort()
    // 起点就是那个被占的端口:顺序扫描的话第一个就会撞上它
    for (let i = 0; i < 5; i += 1) {
      expect(await pickFreePort(occupied)).not.toBe(occupied)
    }
  })

  it('起点是随机的 —— 顺序扫描会让两个实例双双选中区间第一个端口', async () => {
    // 探测与真正 bind 之间隔着一次进程 spawn,那个窗口关不掉;随机起点是把
    // 「几乎必然相撞」摊薄成 1/100 的那一半措施(另一半是 withPortInUseRetry)。
    const base = (await occupyPort()) + 1
    const picked = new Set<number>()
    for (let i = 0; i < 20; i += 1) picked.add(await pickFreePort(base))

    expect(picked.size).toBeGreaterThan(1)
  })
})

describe('isPortInUseError', () => {
  it('认 Node 的 EADDRINUSE(带 code)', () => {
    const err = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4222'), {
      code: 'EADDRINUSE',
    })
    expect(isPortInUseError(err)).toBe(true)
  })

  it.each([
    ['Windows 的 codex(Rust)', 'Codex exited before initialize completed\nos error 10048'],
    ['Unix 的 codex(Rust)', 'Error: Address already in use (os error 98)'],
    ['纯文本的 EADDRINUSE', 'bind failed: EADDRINUSE'],
  ])('认从 stderr 尾巴里捞出来的文本:%s', (_label, message) => {
    // codex 是子进程,端口错误只以 stderr 文本的形式回到我们手里,没有 code 可读
    expect(isPortInUseError(new Error(message))).toBe(true)
  })

  it('不把别的失败当成端口冲突', () => {
    expect(isPortInUseError(new Error('codex binary not found'))).toBe(false)
    expect(isPortInUseError(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe(false)
    expect(isPortInUseError(undefined)).toBe(false)
    expect(isPortInUseError(null)).toBe(false)
  })
})

describe('withPortInUseRetry', () => {
  const portError = (): Error => new Error('spawn failed: os error 10048')

  it('撞车就重来,成功即返回', async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(portError())
      .mockResolvedValueOnce('started')

    await expect(withPortInUseRetry(attempt)).resolves.toBe('started')
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('一直撞就在用尽次数后抛出最后那个错误,不无限重试', async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(portError())

    await expect(withPortInUseRetry(attempt, { attempts: 3 })).rejects.toThrow('os error 10048')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('非端口错误立刻抛 —— 二进制缺失重试一百次也是一样的结果', async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('codex binary not found'))

    await expect(withPortInUseRetry(attempt)).rejects.toThrow('codex binary not found')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('把剩余次数交给 onRetry,好让日志说清还会不会再试', async () => {
    const onRetry = vi.fn()
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(portError())
      .mockResolvedValueOnce('ok')

    await withPortInUseRetry(attempt, { attempts: 3, onRetry })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0][1]).toBe(2)
  })
})
