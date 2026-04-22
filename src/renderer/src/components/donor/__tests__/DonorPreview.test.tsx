import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DonorPreview from '../DonorPreview'
import type { DonorItemView } from '../../../hooks/useHistoryData'

const mockItem: DonorItemView = {
  id: 'abc571019',
  prompt: 'test prompt',
  model: 'gemini',
  ratio: '1:1',
  displayUrls: ['https://example.com/img-a.png', 'https://example.com/img-b.png'],
} as DonorItemView

describe('DonorPreview', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  it('renders SAVE.IMG button when image url exists', () => {
    render(<DonorPreview item={mockItem} startIndex={0} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /SAVE\.IMG/i })).toBeTruthy()
  })

  it('clicking SAVE.IMG triggers anchor download via fetch→blob flow', async () => {
    const fakeBlobUrl = 'blob:http://localhost/fake-blob'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['fake'], { type: 'image/png' })),
    } as Response)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(fakeBlobUrl)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    const created: HTMLAnchorElement[] = []
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreate(tag as 'a') as HTMLAnchorElement
      if (tag === 'a') created.push(el)
      return el as unknown as HTMLElement
    }) as typeof document.createElement)

    render(<DonorPreview item={mockItem} startIndex={0} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /SAVE\.IMG/i }))

    await waitFor(() => {
      const anchor = created.find((a) => a.download)
      expect(anchor).toBeDefined()
      expect(anchor!.href).toBe(fakeBlobUrl)
      expect(anchor!.download).toBe('donor-571019-1.png')
    })
  })

  it('SAVE.IMG button is hidden when no image url', () => {
    const empty = { ...mockItem, displayUrls: [] }
    render(<DonorPreview item={empty} startIndex={0} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: /SAVE\.IMG/i })).toBeNull()
  })
})
