// @vitest-environment node
//
// 视频落盘是一条**失败后果不可逆**的路径:落盘失败等于本地和 COS 都没有副本,
// 只剩上游那条会过期的地址,而且没有第二轮补救。所以这里每条断言都在守一个具体
// 的丢数据场景,不是形式主义。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 造一个行为像 Electron IncomingMessage 的假响应。 */
function fakeResponse(
  chunks: Buffer[],
  opts: { status?: number; contentLength?: number } = {},
): Readable & { statusCode?: number; headers?: Record<string, string | string[]> } {
  const readable = Readable.from(chunks) as Readable & {
    statusCode?: number
    headers?: Record<string, string | string[]>
  }
  readable.statusCode = opts.status ?? 200
  readable.headers = opts.contentLength != null ? { 'content-length': String(opts.contentLength) } : {}
  return readable
}

/**
 * 造一个行为像 net.request 返回值的假请求。
 *
 * `abort()` 必须真的去销毁响应流 —— 这是 Electron 的实际行为(`_die()` 里
 * `this._response.destroy(err)`),而且它**不带错误参数**,所以流是"无错销毁",
 * pipeline 会以 ERR_STREAM_PREMATURE_CLOSE 拒绝而不是拿到我们的超时错误。
 * 测试必须复现这个语义,否则测的就不是真实路径。
 */
function fakeNet(response: Readable & { statusCode?: number }): {
  request: () => EventEmitter
} {
  const request = new EventEmitter() as EventEmitter & { end: () => void; abort: () => void }
  request.end = () => {
    setImmediate(() => request.emit('response', response))
  }
  request.abort = () => {
    response.destroy()
    setImmediate(() => request.emit('abort'))
  }
  return { request: () => request }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('downloadToFile — 流式落盘', () => {
  it('把分块响应完整写进 .part,不在内存里聚合', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'out.mp4')
    const net = fakeNet(fakeResponse([Buffer.from('hello '), Buffer.from('world')], { contentLength: 11 }))

    const res = await downloadToFile('https://x/v.mp4', dest, { net })

    expect(res.bytes).toBe(11)
    expect(res.path).toBe(dest + '.part')
    expect(await fs.readFile(res.path, 'utf8')).toBe('hello world')
  })

  it('非 2xx 直接失败,且不留下 .part', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'out.mp4')
    const net = fakeNet(fakeResponse([Buffer.from('nope')], { status: 404 }))

    await expect(downloadToFile('https://x/v.mp4', dest, { net })).rejects.toThrow(/404/)
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  // 半截文件比没有文件更危险:下游任何靠「文件存在」判断就绪的逻辑都会吃到坏数据。
  it('传输中途出错时清理 .part', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'out.mp4')
    const broken = new Readable({
      read() {
        this.push(Buffer.from('partial'))
        this.destroy(new Error('socket hang up'))
      },
    }) as Readable & { statusCode?: number; headers?: Record<string, string> }
    broken.statusCode = 200
    broken.headers = {}

    await expect(
      downloadToFile('https://x/v.mp4', dest, { net: fakeNet(broken) }),
    ).rejects.toThrow(/socket hang up/)
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  it('请求层直接报错也不留残留', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'out.mp4')
    const request = new EventEmitter() as EventEmitter & { end: () => void; abort: () => void }
    request.end = () => {
      setImmediate(() => request.emit('error', new Error('ECONNREFUSED')))
    }
    request.abort = () => undefined

    await expect(
      downloadToFile('https://x/v.mp4', dest, { net: { request: () => request } }),
    ).rejects.toThrow(/ECONNREFUSED/)
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })
})

describe('downloadToFile — 空闲超时', () => {
  // 这条守的是「不能用整体超时」这个决定:持续缓慢但有数据的传输必须放行,
  // 否则 GB 级文件在慢网下会被自己的超时误杀,而这种失败在测试环境
  //(小文件、快网)永远复现不出来。
  it('持续缓慢但有数据时不超时', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'slow.mp4')

    let n = 0
    const slow = new Readable({
      read() {
        if (n >= 5) {
          this.push(null)
          return
        }
        n += 1
        setTimeout(() => this.push(Buffer.from('x')), 30)
      },
    }) as Readable & { statusCode?: number; headers?: Record<string, string> }
    slow.statusCode = 200
    slow.headers = {}

    // 每块间隔 30ms,空闲阈值 150ms —— 每块都重置看门狗,全程不该超时。
    const res = await downloadToFile('https://x/v.mp4', dest, {
      net: fakeNet(slow),
      idleTimeoutMs: 150,
    })

    expect(res.bytes).toBe(5)
  })

  it('彻底停流则超时,报错说明是停流而非普通中断,并清理 .part', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'stall.mp4')

    // 吐一块之后再也不吐、也不 end —— 半开连接的典型形态。
    const stalled = new Readable({ read() {} }) as Readable & {
      statusCode?: number
      headers?: Record<string, string>
    }
    stalled.statusCode = 200
    stalled.headers = {}
    stalled.push(Buffer.from('start'))

    await expect(
      downloadToFile('https://x/v.mp4', dest, { net: fakeNet(stalled), idleTimeoutMs: 60 }),
    ).rejects.toThrow(/stalled/)
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })
})

describe('downloadVideoToDisk — 校验与原子落位', () => {
  it('校验通过后才 rename;结束时没有 .part 残留', async () => {
    const { downloadVideoToDisk } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'ok.mp4')
    const net = fakeNet(fakeResponse([Buffer.from('0123456789')], { contentLength: 10 }))

    const finalPath = await downloadVideoToDisk('https://x/v.mp4', dest, { net })

    expect(finalPath).toBe(dest)
    expect(await fs.readFile(dest, 'utf8')).toBe('0123456789')
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  // 这条守的是最阴险的一种坏数据:连接中途断开,落盘文件大小合法、看起来
  //「下载好了」,下游任何靠「文件存在」判断就绪的逻辑都会直接吃进去。
  it('字节数与 content-length 不符时判失败,最终路径不产生文件', async () => {
    const { downloadVideoToDisk } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'trunc.mp4')
    const net = fakeNet(fakeResponse([Buffer.from('012345')], { contentLength: 100 }))

    await expect(downloadVideoToDisk('https://x/v.mp4', dest, { net })).rejects.toThrow(
      /incomplete/i,
    )
    await expect(fs.access(dest)).rejects.toThrow()
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  it('上游不给 content-length 时跳过校验,不因此判失败', async () => {
    const { downloadVideoToDisk } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'nolen.mp4')
    const net = fakeNet(fakeResponse([Buffer.from('abc')]))

    expect(await downloadVideoToDisk('https://x/v.mp4', dest, { net })).toBe(dest)
    expect(await fs.readFile(dest, 'utf8')).toBe('abc')
  })

  it('空响应体判失败 —— 0 字节的 mp4 是坏数据不是成功', async () => {
    const { downloadVideoToDisk } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'empty.mp4')
    const net = fakeNet(fakeResponse([]))

    await expect(downloadVideoToDisk('https://x/v.mp4', dest, { net })).rejects.toThrow(/empty/i)
    await expect(fs.access(dest)).rejects.toThrow()
  })
})

describe('renameWithRetry — Windows 上杀软会锁住刚落盘的大文件', () => {
  it('EBUSY 时重试,最终成功', async () => {
    const { renameWithRetry } = await import('../videoDownload')
    const from = path.join(tmpDir, 'a.part')
    const to = path.join(tmpDir, 'a.mp4')
    await fs.writeFile(from, 'data')

    let calls = 0
    const rename = async (f: string, t: string): Promise<void> => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
      await fs.rename(f, t)
    }

    await renameWithRetry(from, to, { rename, delayMs: 0 })

    expect(calls).toBe(3)
    expect(await fs.readFile(to, 'utf8')).toBe('data')
  })

  it('非 EBUSY 错误立刻抛出,不空转', async () => {
    const { renameWithRetry } = await import('../videoDownload')
    let calls = 0
    const rename = async (): Promise<void> => {
      calls += 1
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }

    await expect(
      renameWithRetry(path.join(tmpDir, 'x.part'), path.join(tmpDir, 'x.mp4'), {
        rename,
        delayMs: 0,
      }),
    ).rejects.toThrow(/EACCES/)
    expect(calls).toBe(1)
  })

  // 并发或重试场景下另一次调用可能已经把文件放好了,这时报错是错的。
  it('rename 失败但目标已存在时按成功处理,并清掉源文件', async () => {
    const { renameWithRetry } = await import('../videoDownload')
    const from = path.join(tmpDir, 'b.part')
    const to = path.join(tmpDir, 'b.mp4')
    await fs.writeFile(from, 'mine')
    await fs.writeFile(to, 'already there')

    const rename = async (): Promise<void> => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }

    await renameWithRetry(from, to, { rename, delayMs: 0 })

    expect(await fs.readFile(to, 'utf8')).toBe('already there')
    await expect(fs.access(from)).rejects.toThrow()
  })

  it('EBUSY 一直不消失则最终抛出', async () => {
    const { renameWithRetry } = await import('../videoDownload')
    let calls = 0
    const rename = async (): Promise<void> => {
      calls += 1
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    }

    await expect(
      renameWithRetry(path.join(tmpDir, 'c.part'), path.join(tmpDir, 'c.mp4'), {
        rename,
        delayMs: 0,
        attempts: 4,
      }),
    ).rejects.toThrow(/EBUSY/)
    expect(calls).toBe(4)
  })
})
