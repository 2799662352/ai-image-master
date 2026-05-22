// @vitest-environment jsdom

/**
 * useDisplaySrc — 把模型直出的 b64 dataURL 转成 Blob URL 以避免 <img src=dataURL>
 * 在主线程同步解码巨大 base64 字符串。
 *
 * 行为契约：
 * 1. 输入 data:image/* dataURL → 异步 fetch+blob → URL.createObjectURL → 返回 blob: URL
 * 2. 输入 http(s):// / blob: / file:// / 其他非 dataURL → 原样透传, 不调 fetch
 * 3. 输入 undefined → 返回 undefined
 * 4. 组件卸载时 revoke 本次创建的 blob URL
 * 5. src 由 dataURL A → dataURL B：revoke A 的 blob, 为 B 重新创建
 * 6. src 由 dataURL → http: revoke dataURL 的 blob, 透传 http
 * 7. fetch/blob 失败 → 兜底回退到原 dataURL（用户依然能看到图，只是慢）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

import { useDisplaySrc } from '../useDisplaySrc'

const DATA_URL_A = 'data:image/png;base64,AAAA'
const DATA_URL_B = 'data:image/jpeg;base64,BBBB'
const HTTP_URL = 'https://cdn.example.com/img.png'
const BLOB_URL_EXTERNAL = 'blob:https://app.local/abc'

let createObjectURLCalls: Blob[] = []
let revokeObjectURLCalls: string[] = []
let createObjectURLCounter = 0

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  createObjectURLCalls = []
  revokeObjectURLCalls = []
  createObjectURLCounter = 0

  // 不依赖 jsdom 是否实现 createObjectURL — 直接覆盖一对可观测的 stub
  global.URL.createObjectURL = vi.fn((blob: Blob) => {
    createObjectURLCalls.push(blob)
    createObjectURLCounter += 1
    return `blob:mock://${createObjectURLCounter}`
  }) as unknown as typeof URL.createObjectURL
  global.URL.revokeObjectURL = vi.fn((url: string) => {
    revokeObjectURLCalls.push(url)
  }) as unknown as typeof URL.revokeObjectURL

  // fetch(dataURL) → 模拟 Response.blob()。Hook 内部依赖此能力。
  fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const src = typeof input === 'string' ? input : String(input)
    if (!src.startsWith('data:')) {
      throw new Error(`unexpected fetch in test: ${src}`)
    }
    const match = /^data:([^;,]+);base64,(.*)$/i.exec(src)
    if (!match) throw new Error(`bad data url: ${src}`)
    const [, mime, b64] = match
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const blob = new Blob([bytes], { type: mime })
    return {
      ok: true,
      blob: async () => blob,
    } as unknown as Response
  })
  global.fetch = fetchSpy as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDisplaySrc', () => {
  it('returns undefined for undefined input and does not fetch', () => {
    const { result } = renderHook(() => useDisplaySrc(undefined))
    expect(result.current).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('passes through http URL unchanged without fetching or creating blob', () => {
    const { result } = renderHook(() => useDisplaySrc(HTTP_URL))
    expect(result.current).toBe(HTTP_URL)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(createObjectURLCalls.length).toBe(0)
  })

  it('passes through existing blob: URL unchanged', () => {
    const { result } = renderHook(() => useDisplaySrc(BLOB_URL_EXTERNAL))
    expect(result.current).toBe(BLOB_URL_EXTERNAL)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(createObjectURLCalls.length).toBe(0)
  })

  it('converts data: URL to a blob: URL asynchronously', async () => {
    const { result } = renderHook(() => useDisplaySrc(DATA_URL_A))
    await waitFor(() => {
      expect(result.current).toMatch(/^blob:mock:\/\//)
    })
    expect(fetchSpy).toHaveBeenCalledWith(DATA_URL_A)
    expect(createObjectURLCalls.length).toBe(1)
    expect(createObjectURLCalls[0].type).toBe('image/png')
  })

  it('revokes the created blob URL on unmount', async () => {
    const { result, unmount } = renderHook(() => useDisplaySrc(DATA_URL_A))
    await waitFor(() => {
      expect(result.current).toMatch(/^blob:mock:\/\//)
    })
    const created = result.current
    unmount()
    expect(revokeObjectURLCalls).toContain(created)
  })

  it('revokes old blob and creates new one when data URL changes', async () => {
    const { result, rerender } = renderHook(({ src }) => useDisplaySrc(src), {
      initialProps: { src: DATA_URL_A as string | undefined },
    })
    await waitFor(() => {
      expect(result.current).toMatch(/^blob:mock:\/\//)
    })
    const firstBlobUrl = result.current

    rerender({ src: DATA_URL_B })

    await waitFor(() => {
      expect(result.current).toMatch(/^blob:mock:\/\//)
      expect(result.current).not.toBe(firstBlobUrl)
    })
    expect(revokeObjectURLCalls).toContain(firstBlobUrl)
    expect(createObjectURLCalls.length).toBe(2)
    expect(createObjectURLCalls[1].type).toBe('image/jpeg')
  })

  it('revokes blob and passes through when src becomes http', async () => {
    const { result, rerender } = renderHook(({ src }) => useDisplaySrc(src), {
      initialProps: { src: DATA_URL_A as string | undefined },
    })
    await waitFor(() => {
      expect(result.current).toMatch(/^blob:mock:\/\//)
    })
    const firstBlobUrl = result.current

    rerender({ src: HTTP_URL })

    await waitFor(() => {
      expect(result.current).toBe(HTTP_URL)
    })
    expect(revokeObjectURLCalls).toContain(firstBlobUrl)
  })

  it('falls back to original data URL when fetch fails', async () => {
    fetchSpy.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const { result } = renderHook(() => useDisplaySrc(DATA_URL_A))
    await waitFor(() => {
      expect(result.current).toBe(DATA_URL_A)
    })
    expect(createObjectURLCalls.length).toBe(0)
  })

  it('synchronously clears blob URL when src changes (no stale paint)', async () => {
    // 同 useFileUrl 注释里讲的: 输入变化时必须同步把 state 置成新的预备值, 否则 React
    // 会用旧 blob URL 多画一帧, 而 effect cleanup 已经 revoke 掉它 → ERR_FILE_NOT_FOUND
    const { result, rerender } = renderHook(({ src }) => useDisplaySrc(src), {
      initialProps: { src: DATA_URL_A as string | undefined },
    })
    await waitFor(() => {
      expect(result.current).toMatch(/^blob:mock:\/\//)
    })

    // 切到 http: 当帧就应该是 http, 不能还残留旧 blob URL
    act(() => {
      rerender({ src: HTTP_URL })
    })
    expect(result.current).toBe(HTTP_URL)
  })
})
