// src/renderer/src/components/donor/__tests__/DonorVirtualGrid.test.tsx
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import DonorVirtualGrid from '../DonorVirtualGrid'
import type { DonorItemView } from '../../../hooks/useHistoryData'

// Capture the most recently installed ResizeObserver callback so individual
// tests can drive the virtualized branch by simulating a layout measurement.
let lastRoCallback: ((entries: Array<{ contentRect: { width: number } }>) => void) | null = null

beforeAll(() => {
  // jsdom does not ship ResizeObserver
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).ResizeObserver = class {
    constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
      lastRoCallback = cb
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

beforeEach(() => {
  lastRoCallback = null
})

// Explicit cleanup — Vitest + RTL auto-cleanup is unreliable in this project's
// setup (other tests already do their own cleanup), so we lock it down here.
afterEach(() => {
  cleanup()
})

function makeItem(i: number): DonorItemView {
  return {
    id: i,
    prompt: `item-${i}`,
    urls: [`https://example.com/${i}.png`],
    displayUrls: [`https://example.com/${i}.png`],
    status: 'ok-local',
    isBroken: false,
    // 必填字段,`.png` 走的正是 `useHistoryData.toView` 会算出 false 的那条路
    // (`VIDEO_URL_RE` 不匹配)。省掉它并不是「默认 false」,而是整个夹具不再满足
    // `DonorItemView` —— 卡片按 `isVideo` 决定渲染 <img> 还是 <video>。
    isVideo: false,
  }
}

describe('DonorVirtualGrid', () => {
  it('renders CSS grid (not react-window) when items < 30', () => {
    const items = Array.from({ length: 5 }, (_, i) => makeItem(i))
    render(
      <DonorVirtualGrid
        items={items}
        onDelete={vi.fn()}
        onPreview={vi.fn()}
      />,
    )
    // CSS grid path renders all cards directly; react-window Grid sets role="grid"
    expect(screen.queryByRole('grid')).toBeNull()
    // Each item is rendered (alt text comes from item.prompt via DonorCard)
    expect(screen.getAllByRole('img')).toHaveLength(5)
  })

  it('does not render react-window Grid until containerWidth>0 (initial mount)', () => {
    // Even with 100 items, initial mount has containerWidth=0 so we fall back to CSS grid
    const items = Array.from({ length: 100 }, (_, i) => makeItem(i))
    render(
      <DonorVirtualGrid
        items={items}
        onDelete={vi.fn()}
        onPreview={vi.fn()}
      />,
    )
    // CSS-grid fallback path renders all 100 cards (no measurement yet)
    expect(screen.queryByRole('grid')).toBeNull()
  })

  it('switches to react-window <Grid> after the container is measured (>=30 items)', () => {
    const items = Array.from({ length: 100 }, (_, i) => makeItem(i))
    render(
      <DonorVirtualGrid
        items={items}
        onDelete={vi.fn()}
        onPreview={vi.fn()}
      />,
    )

    // Pre-measurement: still CSS-grid fallback
    expect(screen.queryByRole('grid')).toBeNull()
    expect(lastRoCallback).not.toBeNull()

    // Simulate the browser measuring the container at 1200px wide.
    act(() => {
      lastRoCallback?.([{ contentRect: { width: 1200 } }])
    })

    // react-window's <Grid> renders its outer wrapper with role="grid".
    expect(screen.queryByRole('grid')).not.toBeNull()
    // Virtualized: only a viewport-worth of cards are mounted, not all 100.
    // DonorCard renders an <article>; react-window v2's custom cellComponent
    // (our VirtualCell) is a plain <div>, so we count articles directly.
    const cards = document.querySelectorAll('article')
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.length).toBeLessThan(100)
  })

  it('keeps CSS-grid fallback even after measurement when items < 30', () => {
    const items = Array.from({ length: 12 }, (_, i) => makeItem(i))
    render(
      <DonorVirtualGrid
        items={items}
        onDelete={vi.fn()}
        onPreview={vi.fn()}
      />,
    )
    act(() => {
      lastRoCallback?.([{ contentRect: { width: 1200 } }])
    })
    // Threshold guard: even with a measured width, small lists stay on CSS grid.
    expect(screen.queryByRole('grid')).toBeNull()
    expect(screen.getAllByRole('img')).toHaveLength(12)
  })
})
