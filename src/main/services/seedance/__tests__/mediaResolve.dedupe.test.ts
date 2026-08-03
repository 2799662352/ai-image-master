// @vitest-environment node
//
// 本地文件中转的 in-flight 合并。
//
// 解决的是这个:工作台 `startCards` 一次把所有卡片放出去,同一张角色参考图挂在
// 10 张卡上就会在同一时刻发起 10 次上传 —— `relayKey` 每次调用都 randomBytes
// 生成新 key,各传一份。上游素材接口自己按内容去重(重复导入直接返回已有记录),
// 救不了已经花掉的上传。
//
// **这里合并的是「同一瞬间的重复」,不是「上次的结果」。** 刻意不做结果缓存:
// 记住 URL 意味着可能返回一个已被 COS 生命周期清掉的地址(上游报 502「远程素材
// URL 已失效」),也意味着用户在外部改了图、工具却保留了 mtime 与体积时会拿到旧图。
// 下面有几条用例专门钉住「不留记忆」这一点。

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

/** 一次不会自己完成的上传,用来把 in-flight 窗口撑开。 */
function pendingUpload(): { started: () => number; finish: (url: string) => void } {
  let started = 0
  let resolveOne!: (url: string) => void
  relayFileToCos.mockImplementation(() => {
    started += 1
    return new Promise<string>((res) => {
      resolveOne = res
    })
  })
  return { started: () => started, finish: (url) => resolveOne(url) }
}

let resolveMediaUrl: typeof import('../mediaResolve').resolveMediaUrl
let reset: typeof import('../mediaResolve').__resetMediaResolveInFlightForTests

beforeEach(async () => {
  relayDataUrlToCos.mockReset()
  relayFileToCos.mockReset()
  stat.mockReset()
  readFile.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const mod = await import('../mediaResolve')
  resolveMediaUrl = mod.resolveMediaUrl
  reset = mod.__resetMediaResolveInFlightForTests
  reset()
})

afterEach(() => {
  reset?.()
  vi.restoreAllMocks()
})

describe('resolveMediaUrl — in-flight 合并', () => {
  it('同一瞬间的多次请求合并成一次上传,拿到同一个 URL', async () => {
    fileStat(BIG, 1_700_000_000_000)
    const upload = pendingUpload()

    const runs = Array.from({ length: 6 }, (_, i) =>
      resolveMediaUrl('C:/refs/hero.png', `referenceImages[${i}]`),
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(upload.started()).toBe(1)

    upload.finish('https://cos/hero.png')
    const urls = await Promise.all(runs)
    expect(new Set(urls)).toEqual(new Set(['https://cos/hero.png']))
  })

  it('图片入口(alwaysRelay)与视频入口(超阈值)同时要同一张大图时也合并', async () => {
    fileStat(BIG, 1_700_000_000_000)
    const upload = pendingUpload()

    const fromImage = resolveMediaUrl('C:/refs/hero.png', 'referenceImage', undefined, {
      alwaysRelay: true,
    })
    const fromVideo = resolveMediaUrl('C:/refs/hero.png', 'referenceImages[0]')
    await Promise.resolve()
    await Promise.resolve()

    // 键不带 alwaysRelay —— 走到中转这一步时该开关已不再区分行为。
    expect(upload.started()).toBe(1)

    upload.finish('https://cos/hero.png')
    expect(await fromImage).toBe('https://cos/hero.png')
    expect(await fromVideo).toBe('https://cos/hero.png')
  })

  it('上一次已经结束之后,再要同一个文件会重新上传 —— 不留记忆', async () => {
    fileStat(BIG, 1_700_000_000_000)
    relayFileToCos.mockResolvedValueOnce('https://cos/first.png')
    expect(await resolveMediaUrl('C:/refs/hero.png', 'ref')).toBe('https://cos/first.png')

    relayFileToCos.mockResolvedValueOnce('https://cos/second.png')
    expect(await resolveMediaUrl('C:/refs/hero.png', 'ref')).toBe('https://cos/second.png')

    // 两次都真的上传了:不会返回一个可能已被 COS 生命周期清掉的旧地址。
    expect(relayFileToCos).toHaveBeenCalledTimes(2)
  })

  it('不同文件不会互相合并', async () => {
    fileStat(BIG, 1_700_000_000_000)
    const upload = pendingUpload()

    void resolveMediaUrl('C:/refs/a.png', 'ref').catch(() => {})
    void resolveMediaUrl('C:/refs/b.png', 'ref').catch(() => {})
    await Promise.resolve()
    await Promise.resolve()

    expect(upload.started()).toBe(2)
    reset()
  })

  it('失败也把 in-flight 条目清掉,下一次仍会重试', async () => {
    fileStat(BIG, 1_700_000_000_000)
    relayFileToCos.mockRejectedValueOnce(new Error('network down'))
    await expect(resolveMediaUrl('C:/refs/hero.png', 'ref')).rejects.toThrow()

    relayFileToCos.mockResolvedValueOnce('https://cos/ok.png')
    await expect(resolveMediaUrl('C:/refs/hero.png', 'ref')).resolves.toBe('https://cos/ok.png')
    expect(relayFileToCos).toHaveBeenCalledTimes(2)
  })

  it('小文件走内联捷径,压根不进 in-flight 表', async () => {
    fileStat(1024, 1_700_000_000_000)
    const inlined = await resolveMediaUrl('C:/refs/small.png', 'ref')

    expect(inlined.startsWith('data:')).toBe(true)
    expect(relayFileToCos).not.toHaveBeenCalled()
  })

  it('http(s) / asset:// 透传不受影响', async () => {
    expect(await resolveMediaUrl('https://cdn/x.png', 'ref')).toBe('https://cdn/x.png')
    expect(await resolveMediaUrl('asset://abc', 'ref')).toBe('asset://abc')
    expect(stat).not.toHaveBeenCalled()
    expect(relayFileToCos).not.toHaveBeenCalled()
  })
})
