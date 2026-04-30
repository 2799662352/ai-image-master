// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { EraseResultCard } from './EraseResultCard'
import type { EraseHistoryItem } from '../../../../types/smartErase'

vi.mock('../../stores/useEraseSessionStore', () => {
  const setModalItemId = vi.fn()
  return {
    useEraseSessionStore: (selector: any) => selector({ setModalItemId }),
    __setModalItemId: setModalItemId,
  }
})

function makeItem(overrides: Partial<EraseHistoryItem> = {}): EraseHistoryItem {
  return {
    id: 'item-1',
    filename: 'test.mp4',
    fileSize: 8_000_000,
    durationSeconds: 15,
    videoUrl: 'https://cos.example.com/output.mp4',
    videoExpiresAt: Date.now() + 6 * 86_400_000,
    posterDataUrl: '',
    outputCosKey: 'out/key',
    inputCosKey: 'in/key',
    originalFilePath: '/local/test.mp4',
    createdAt: Date.now() - 60_000,
    ...overrides,
  }
}

afterEach(cleanup)

describe('EraseResultCard', () => {
  it('renders DONE badge', () => {
    render(<EraseResultCard item={makeItem()} />)
    expect(screen.getByText('DONE')).toBeTruthy()
  })

  it('shows expiry days badge when > 1 day', () => {
    render(<EraseResultCard item={makeItem({ videoExpiresAt: Date.now() + 6 * 86_400_000 })} />)
    expect(screen.getByText('6d')).toBeTruthy()
  })

  it('shows expiry hours badge when < 24h', () => {
    render(<EraseResultCard item={makeItem({ videoExpiresAt: Date.now() + 4 * 3_600_000 })} />)
    expect(screen.getByText('4h')).toBeTruthy()
  })

  it('shows 已过期 badge when expired', () => {
    render(<EraseResultCard item={makeItem({ videoExpiresAt: Date.now() - 1000 })} />)
    expect(screen.getByText('已过期')).toBeTruthy()
  })

  it('shows truncated filename', () => {
    render(<EraseResultCard item={makeItem({ filename: 'my_long_video_name.mp4' })} />)
    expect(screen.getByText('my_long_video_name.mp4')).toBeTruthy()
  })

  it('calls setModalItemId on click', async () => {
    const mod = await import('../../stores/useEraseSessionStore')
    const mockFn = (mod as any).__setModalItemId
    mockFn.mockClear()

    render(<EraseResultCard item={makeItem()} />)
    screen.getByRole('button').click()
    expect(mockFn).toHaveBeenCalledWith('item-1')
  })
})
