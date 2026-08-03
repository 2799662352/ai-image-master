// @vitest-environment node
//
// 本地文件的中转去重。
//
// 为什么需要:同一张角色参考图挂在工作台的 10 张卡上,今天会被上传 10 次拿到 10 个
// 不同的 COS URL —— relayKey 每次调用都 randomBytes 生成新 key,没有任何缓存或
// in-flight 合并。上游素材接口自己会按内容去重(重复导入直接返回已有记录),白花的
// 纯粹是我们这边的上传。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const relayDataUrlToCos = vi.fn()
const relayFileToCos = vi.fn()
const stat = vi.fn()
const readFile = vi.fn()

vi.mock('../../tencent/mediaRelay', () => ({
  relayDataUrlToCos: (...a: unknown[]) => relayDataUrlToCos(...a),
  relayFileToCos: (...a: unknown[]) => relayFileToCos(...a),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    stat: (...a: unknown[]) => stat(...a),
    readFile: (...a: unknown[]) => readFile(...a),
  },
}))

const BIG = 2 * 1024 * 1024

function fileStat(bytes: number, mtimeMs: number) {
  stat.mockResolvedValue({ size: bytes, mtimeMs, isFile: () => true })
  readFile.mockResolvedValue(Buffer.from('fake-bytes'))
}

let resolveMediaUrl: typeof import('../mediaResolve').resolveMediaUrl
let reset: typeof import('../mediaResolve').__resetMediaResolveCacheForTests

beforeEach(async () => {
  relayDataUrlToCos.mockReset()
  relayFileToCos.mockReset()
  stat.mockReset()
  readFile.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const mod = await import('../mediaResolve')
  resolveMediaUrl = mod.resolveMediaUrl
  reset = mod.__resetMediaResolveCacheForTests
  reset()
})

afterEach(() => {
  reset?.()
  vi.restoreAllMocks()
})

describe('resolveMediaUrl — 本地文件中转去重', () => {
  it('同一个文件解析两次,只上传一次,两次拿到同一个 URL', async () => {
    fileStat(BIG, 1_700_000_000_000)
    relayFileToCos.mockResolvedValue('https://cos/a.png')

    const first = await resolveMediaUrl('C:/refs/hero.png', 'referenceImages[0]')
    const second = await resolveMediaUrl('C:/refs/hero.png', 'referenceImages[3]')

    expect(first).toBe('https://cos/a.png')
    expect(second).toBe('https://cos/a.png')
    expect(relayFileToCos).toHaveBeenCalledTimes(1)
  })

  it('并发解析同一个文件时合并成一次上传', async () => {
    fileStat(BIG, 1_700_000_000_000)
    let started = 0
    relayFileToCos.mockImplementation(() => {
      started += 1
      return new Promise((res) => setTimeout(() => res('https://cos/a.png'), 5))
    })

    const urls = await Promise.all(
      Array.from({ length: 6 }, (_, i) => resolveMediaUrl('C:/refs/hero.png', `ref[${i}]`)),
    )

    expect(started).toBe(1)
    expect(new Set(urls).size).toBe(1)
  })

  it('文件改了(mtime 变)就重新上传', async () => {
    fileStat(BIG, 1_700_000_000_000)
    relayFileToCos.mockResolvedValueOnce('https://cos/v1.png')
    await resolveMediaUrl('C:/refs/hero.png', 'ref')

    fileStat(BIG, 1_700_000_009_999)
    relayFileToCos.mockResolvedValueOnce('https://cos/v2.png')
    const second = await resolveMediaUrl('C:/refs/hero.png', 'ref')

    expect(second).toBe('https://cos/v2.png')
    expect(relayFileToCos).toHaveBeenCalledTimes(2)
  })

  it('体积变了也重新上传(mtime 精度不够时的第二道判据)', async () => {
    fileStat(BIG, 1_700_000_000_000)
    relayFileToCos.mockResolvedValueOnce('https://cos/v1.png')
    await resolveMediaUrl('C:/refs/hero.png', 'ref')

    fileStat(BIG + 1024, 1_700_000_000_000)
    relayFileToCos.mockResolvedValueOnce('https://cos/v2.png')
    await resolveMediaUrl('C:/refs/hero.png', 'ref')

    expect(relayFileToCos).toHaveBeenCalledTimes(2)
  })

  it('alwaysRelay 不同的两次调用不共用缓存 —— 它们的返回形态本就不同', async () => {
    // 小文件:默认走内联,alwaysRelay 才走 COS。串味会让内联那次拿到 COS URL。
    fileStat(1024, 1_700_000_000_000)
    relayFileToCos.mockResolvedValue('https://cos/small.png')

    const relayed = await resolveMediaUrl('C:/refs/small.png', 'ref', undefined, {
      alwaysRelay: true,
    })
    const inlined = await resolveMediaUrl('C:/refs/small.png', 'ref')

    expect(relayed).toBe('https://cos/small.png')
    expect(inlined.startsWith('data:')).toBe(true)
  })

  it('中转失败不进缓存,下一次仍会重试', async () => {
    fileStat(BIG, 1_700_000_000_000)
    relayFileToCos.mockRejectedValueOnce(new Error('network down'))
    await expect(resolveMediaUrl('C:/refs/hero.png', 'ref')).rejects.toThrow()

    relayFileToCos.mockResolvedValueOnce('https://cos/ok.png')
    await expect(resolveMediaUrl('C:/refs/hero.png', 'ref')).resolves.toBe('https://cos/ok.png')
    expect(relayFileToCos).toHaveBeenCalledTimes(2)
  })

  it('降级内联的结果不进缓存 —— 缓存内联等于把整个文件常驻内存', async () => {
    // 512KB~1MB 窗口:中转挂了仍可内联。
    fileStat(700 * 1024, 1_700_000_000_000)
    relayFileToCos.mockRejectedValue(new Error('cos down'))

    const first = await resolveMediaUrl('C:/refs/mid.png', 'ref', undefined, { alwaysRelay: true })
    const second = await resolveMediaUrl('C:/refs/mid.png', 'ref', undefined, { alwaysRelay: true })

    expect(first.startsWith('data:')).toBe(true)
    expect(second.startsWith('data:')).toBe(true)
    // 两次都真的重试了中转,没有把内联结果当成「已解析」缓存下来。
    expect(relayFileToCos).toHaveBeenCalledTimes(2)
  })

  it('noCache 时每次都真传一份新的 —— 生图参考图走这条', async () => {
    // 每一次生图都是一次全新任务。更要紧的是:同一张图在一次调用里出现两次
    // (「图1 与 图3 是同一个人」)时,复用同一个 URL 可能被上游按地址折叠成一个
    // 参考,后面的编号就全体前移了。
    fileStat(BIG, 1_700_000_000_000)
    relayFileToCos.mockResolvedValueOnce('https://cos/first.png')
    relayFileToCos.mockResolvedValueOnce('https://cos/second.png')

    const a = await resolveMediaUrl('C:/refs/hero.png', 'ref', undefined, {
      alwaysRelay: true,
      noCache: true,
    })
    const b = await resolveMediaUrl('C:/refs/hero.png', 'ref', undefined, {
      alwaysRelay: true,
      noCache: true,
    })

    expect(relayFileToCos).toHaveBeenCalledTimes(2)
    expect(a).not.toBe(b)
  })

  it('noCache 的调用不会污染缓存,也不会被之前的缓存命中', async () => {
    fileStat(BIG, 1_700_000_000_000)
    relayFileToCos.mockResolvedValue('https://cos/cached.png')

    // 先用带缓存的路径存一条。
    await resolveMediaUrl('C:/refs/hero.png', 'ref', undefined, { alwaysRelay: true })
    expect(relayFileToCos).toHaveBeenCalledTimes(1)

    // noCache 必须无视它,真传第二次。
    await resolveMediaUrl('C:/refs/hero.png', 'ref', undefined, {
      alwaysRelay: true,
      noCache: true,
    })
    expect(relayFileToCos).toHaveBeenCalledTimes(2)

    // 而且没把自己的结果写进缓存 —— 带缓存的那条仍命中第一次的结果。
    await resolveMediaUrl('C:/refs/hero.png', 'ref', undefined, { alwaysRelay: true })
    expect(relayFileToCos).toHaveBeenCalledTimes(2)
  })

  it('http(s) / asset:// / data: 透传不受缓存影响', async () => {
    expect(await resolveMediaUrl('https://cdn/x.png', 'ref')).toBe('https://cdn/x.png')
    expect(await resolveMediaUrl('asset://abc', 'ref')).toBe('asset://abc')
    expect(stat).not.toHaveBeenCalled()
    expect(relayFileToCos).not.toHaveBeenCalled()
  })
})
