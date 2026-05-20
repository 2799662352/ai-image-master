// src/renderer/src/components/donor/__tests__/DonorVirtualGrid.test.tsx
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import DonorVirtualGrid from '../DonorVirtualGrid'
import type { DonorItemView } from '../../../hooks/useHistoryData'

beforeAll(() => {
  // jsdom does not ship ResizeObserver
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

function makeItem(i: number): DonorItemView {
  return {
    id: i,
    prompt: `item-${i}`,
    urls: [`https://example.com/${i}.png`],
    displayUrls: [`https://example.com/${i}.png`],
    status: 'ok-local',
    isBroken: false,
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
})
