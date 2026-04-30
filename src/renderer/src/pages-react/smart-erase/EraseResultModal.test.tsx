// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { EraseResultModal } from './EraseResultModal'

const setModalItemId = vi.fn()

vi.mock('../../stores/useEraseSessionStore', () => ({
  useEraseSessionStore: (sel: any) => sel({
    modalItemId: 'item-1',
    setModalItemId,
  }),
}))

vi.mock('../../stores/useErasePersistStore', () => ({
  useErasePersistStore: (sel: any) => sel({
    history: [{
      id: 'item-1',
      filename: 'test.mp4',
      fileSize: 5_000_000,
      durationSeconds: 10,
      videoUrl: 'https://cos.example.com/out.mp4',
      videoExpiresAt: Date.now() + 86_400_000,
      posterDataUrl: '',
      outputCosKey: 'out/k',
      inputCosKey: 'in/k',
      originalFilePath: '/local/test.mp4',
      createdAt: Date.now(),
    }],
    removeHistory: vi.fn(),
    _hasHydrated: true,
  }),
}))

vi.mock('../../stores', () => ({
  useToastStore: (sel: any) => sel({ addToast: vi.fn() }),
}))

describe('EraseResultModal', () => {
  beforeEach(() => {
    setModalItemId.mockClear()
  })

  it('opens dialog when modalItemId matches a history item', () => {
    render(<EraseResultModal />)
    const dialog = document.querySelector('dialog')
    expect(dialog?.open).toBe(true)
  })

  it('calls setModalItemId(null) when dialog close event fires', () => {
    render(<EraseResultModal />)
    const dialog = document.querySelector('dialog')
    act(() => { dialog?.close() })
    expect(setModalItemId).toHaveBeenCalledWith(null)
  })

  it('displays filename in modal header', () => {
    render(<EraseResultModal />)
    expect(screen.getByText(/test\.mp4/)).toBeTruthy()
  })
})
