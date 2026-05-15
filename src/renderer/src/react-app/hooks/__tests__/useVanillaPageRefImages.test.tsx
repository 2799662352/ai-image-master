import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useVanillaPageRefImages } from '../useVanillaPageRefImages'

interface TestImage {
  id: number
  name: string
}

function setupVanillaPage(initial: TestImage[] = []) {
  // 1) 在 DOM 上挂一个空的 preview 容器
  const previewEl = document.createElement('div')
  previewEl.id = 'test-preview'
  document.body.appendChild(previewEl)

  // 2) 在 window 上挂一个假的 vanilla page 实例
  const state: { images: TestImage[] } = { images: [...initial] }
  ;(window as any).fakeVanillaPage = {
    getReferenceImages: () => state.images,
  }

  const setImagesAndRender = (next: TestImage[]) => {
    state.images = next
    // 重新渲染缩略图节点 → 触发 MutationObserver
    previewEl.innerHTML = next
      .map((img) => `<div data-id="${img.id}">${img.name}</div>`)
      .join('')
  }

  // 先把初始 images 渲染到 DOM
  setImagesAndRender(initial)

  return {
    previewEl,
    setImagesAndRender,
    cleanup: () => {
      previewEl.remove()
      delete (window as any).fakeVanillaPage
    },
  }
}

const getFakePage = () => (window as any).fakeVanillaPage ?? null

describe('useVanillaPageRefImages', () => {
  let env: ReturnType<typeof setupVanillaPage>

  beforeEach(() => {
    env = setupVanillaPage([])
  })

  afterEach(() => {
    env.cleanup()
  })

  it('returns the initial reference images on mount', async () => {
    env.setImagesAndRender([
      { id: 1, name: 'a.png' },
      { id: 2, name: 'b.png' },
    ])

    const { result } = renderHook(() =>
      useVanillaPageRefImages<TestImage>({
        getPage: getFakePage,
        previewElementId: 'test-preview',
        same: (a, b) => a?.id === b?.id,
      }),
    )

    await waitFor(() => expect(result.current.length).toBe(2))
    expect(result.current[0].id).toBe(1)
    expect(result.current[1].id).toBe(2)
  })

  it('updates when DOM mutates (event-driven, no polling)', async () => {
    const { result } = renderHook(() =>
      useVanillaPageRefImages<TestImage>({
        getPage: getFakePage,
        previewElementId: 'test-preview',
        same: (a, b) => a?.id === b?.id,
      }),
    )

    expect(result.current).toEqual([])

    act(() => {
      env.setImagesAndRender([{ id: 1, name: 'a.png' }])
    })

    await waitFor(() => expect(result.current.length).toBe(1))
    expect(result.current[0].id).toBe(1)

    act(() => {
      env.setImagesAndRender([
        { id: 1, name: 'a.png' },
        { id: 5, name: 'new.png' },
      ])
    })

    await waitFor(() => expect(result.current.length).toBe(2))
    expect(result.current[1].id).toBe(5)
  })

  it('reflects removal when DOM nodes are cleared', async () => {
    env.setImagesAndRender([{ id: 1, name: 'a.png' }])

    const { result } = renderHook(() =>
      useVanillaPageRefImages<TestImage>({
        getPage: getFakePage,
        previewElementId: 'test-preview',
        same: (a, b) => a?.id === b?.id,
      }),
    )

    await waitFor(() => expect(result.current.length).toBe(1))

    act(() => {
      env.setImagesAndRender([])
    })

    await waitFor(() => expect(result.current.length).toBe(0))
  })

  it('attaches lazily when preview element appears after mount (fallback path)', async () => {
    // 移除已有 preview, 等组件挂载时不会立刻找到
    env.previewEl.remove()
    vi.useFakeTimers()

    try {
      const { result } = renderHook(() =>
        useVanillaPageRefImages<TestImage>({
          getPage: getFakePage,
          previewElementId: 'test-preview',
          same: (a, b) => a?.id === b?.id,
        }),
      )

      expect(result.current).toEqual([])

      // 模拟"页面 lazy 渲染": 1.2s 后才把 preview 挂回 DOM
      const lateEl = document.createElement('div')
      lateEl.id = 'test-preview'
      lateEl.innerHTML = '<div data-id="9">late.png</div>'
      ;(window as any).fakeVanillaPage = {
        getReferenceImages: () => [{ id: 9, name: 'late.png' }],
      }
      document.body.appendChild(lateEl)
      env.previewEl = lateEl

      // 1s 慢轮询命中后会做一次 pull
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100)
      })

      expect(result.current.length).toBe(1)
      expect(result.current[0].id).toBe(9)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not invoke setState when shallow equality holds (avoids re-render loops)', async () => {
    env.setImagesAndRender([{ id: 1, name: 'a.png' }])

    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount += 1
      return useVanillaPageRefImages<TestImage>({
        getPage: getFakePage,
        previewElementId: 'test-preview',
        same: (a, b) => a?.id === b?.id,
      })
    })

    await waitFor(() => expect(result.current.length).toBe(1))
    const baselineRenders = renderCount

    // 同一个引用、同一个 id, mutate 但没真"变化"
    act(() => {
      env.setImagesAndRender([{ id: 1, name: 'a.png' }])
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(renderCount - baselineRenders).toBeLessThanOrEqual(1)
  })
})
