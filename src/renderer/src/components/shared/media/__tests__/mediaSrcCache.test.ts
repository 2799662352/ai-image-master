// 共享媒体缓存的去重与引用计数:同一份字节只读一次盘、只造一个 blob,而且只在
// 最后一个持有者放手时才 revoke。
//
// 断言直接数 IPC 次数与 createObjectURL/revokeObjectURL 次数 —— 省下来的就是这些,
// 数别的都是间接证据。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireMediaSrc,
  releaseMediaSrc,
  resetMediaSrcCacheForTest,
} from '../useResolvedMediaSrc'

const A = 'local-file:///D%3A/shots/a.png'
const B = 'local-file:///D%3A/shots/b.png'

let readThumb: ReturnType<typeof vi.fn>
let created: string[]
let revoked: string[]
let nextId: number

beforeEach(() => {
  nextId = 0
  created = []
  revoked = []
  readThumb = vi.fn(async () => ({ ok: true as const, base64: 'AAA', mime: 'image/png' }))
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: { readThumb, readMediaThumb: readThumb },
  }
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:stub-${++nextId}`
    created.push(url)
    return url
  }) as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url)
  }) as unknown as typeof URL.revokeObjectURL
})

afterEach(() => {
  resetMediaSrcCacheForTest()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  vi.restoreAllMocks()
})

describe('acquireMediaSrc 去重', () => {
  it('同一个源取两次只读一次盘、只造一个 blob', async () => {
    const [u1, u2] = await Promise.all([acquireMediaSrc(A, 'image'), acquireMediaSrc(A, 'image')])
    expect(u1).toBe(u2)
    expect(readThumb).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
  })

  it('先后取(第二次时已解析完)也命中缓存', async () => {
    const first = await acquireMediaSrc(A, 'image')
    const second = await acquireMediaSrc(A, 'image')
    expect(second).toBe(first)
    expect(readThumb).toHaveBeenCalledTimes(1)
  })

  it('不同源各读一次', async () => {
    await Promise.all([acquireMediaSrc(A, 'image'), acquireMediaSrc(B, 'image')])
    expect(readThumb).toHaveBeenCalledTimes(2)
    expect(created).toHaveLength(2)
  })

  it('fullFidelity / thumbSize 分区缓存 —— 灯箱不能被喂 256px 缩略图', async () => {
    await acquireMediaSrc(A, 'image')
    await acquireMediaSrc(A, 'image', { fullFidelity: true })
    await acquireMediaSrc(A, 'image', { thumbSize: 512 })
    expect(readThumb).toHaveBeenCalledTimes(3)
  })

  it('直通源(data:/https)不进缓存,不发 IPC 也不造 blob', async () => {
    expect(await acquireMediaSrc('https://x/a.png', 'image')).toBe('https://x/a.png')
    expect(await acquireMediaSrc('data:image/png;base64,AAA', 'image')).toBe(
      'data:image/png;base64,AAA',
    )
    expect(readThumb).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
    // release 直通源是无操作,不该炸也不该 revoke
    releaseMediaSrc('https://x/a.png', 'image')
    expect(revoked).toHaveLength(0)
  })
})

describe('引用计数', () => {
  it('两个持有者:放手一个不 revoke,放手两个才 revoke', async () => {
    const url = await acquireMediaSrc(A, 'image')
    await acquireMediaSrc(A, 'image')

    releaseMediaSrc(A, 'image')
    expect(revoked).toHaveLength(0)

    releaseMediaSrc(A, 'image')
    expect(revoked).toEqual([url])
  })

  it('全部放手后再取会重新读盘(缓存行已删)', async () => {
    await acquireMediaSrc(A, 'image')
    releaseMediaSrc(A, 'image')
    await acquireMediaSrc(A, 'image')
    expect(readThumb).toHaveBeenCalledTimes(2)
  })

  it('解析途中就放手:blob 一到手立刻 revoke,不留缓存行', async () => {
    const pending = acquireMediaSrc(A, 'image')
    releaseMediaSrc(A, 'image')

    expect(await pending).toBeNull()
    expect(revoked).toEqual(created)
    // 缓存行没留下 → 下一次取会重新读
    await acquireMediaSrc(A, 'image')
    expect(readThumb).toHaveBeenCalledTimes(2)
  })

  it('多放手不会把计数压到负,后来的持有者仍安全', async () => {
    const url = await acquireMediaSrc(A, 'image')
    releaseMediaSrc(A, 'image')
    releaseMediaSrc(A, 'image') // 多余的一次:缓存行已删,应为无操作
    expect(revoked).toEqual([url])

    const again = await acquireMediaSrc(A, 'image')
    expect(again).not.toBeNull()
    releaseMediaSrc(A, 'image')
    expect(revoked).toHaveLength(2)
  })
})

describe('失败不粘住', () => {
  it('读失败返回 null 且不缓存 —— 文件后来出现时还能解析出来', async () => {
    // ENOENT 是硬失败(不匹配 readBytes 里的软失败正则),第一趟就返回,只吃一个 mock
    readThumb.mockResolvedValueOnce({ ok: false as const, reason: 'ENOENT' })

    expect(await acquireMediaSrc(A, 'image')).toBeNull()

    const later = await acquireMediaSrc(A, 'image')
    expect(later).not.toBeNull()
  })
})
