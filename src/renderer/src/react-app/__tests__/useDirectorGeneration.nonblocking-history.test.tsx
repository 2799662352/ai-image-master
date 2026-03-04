import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDirectorGeneration } from '../hooks/useDirectorGeneration'
import { useDirectorStore } from '../stores/useDirectorStore'

const mockExecute = vi.fn()
const mockGetDirectorPipelineService = vi.fn()

vi.mock('@/services/ServiceBridge', () => ({
  getDirectorPipelineService: (...args: any[]) => mockGetDirectorPipelineService(...args),
}))

function TestHarness({ onDone, onError }: { onDone: () => void; onError: (e: unknown) => void }) {
  const { startGeneration } = useDirectorGeneration()

  return (
    <button
      onClick={() => {
        startGeneration().then(onDone).catch(onError)
      }}
    >
      start
    </button>
  )
}

describe('useDirectorGeneration - non-blocking history save', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDirectorStore.getState().reset()

    useDirectorStore.getState().addReferenceImage({
      data: 'ZmFrZQ==',
      mimeType: 'image/png',
      name: 'ref.png',
    })
    useDirectorStore.getState().setSceneDescription('test scene')
    useDirectorStore.getState().setImageCount(2)
    useDirectorStore.getState().setSkipVerify(true)
    useDirectorStore.getState().setScoreThreshold(8)
    useDirectorStore.getState().setVisionModel('gemini-vision-test')
    useDirectorStore.getState().setImageModel('gemini-image-test')

    mockExecute.mockResolvedValue({
      images: [
        { url: 'https://example.com/1.png', prompt: 'p1' },
        { url: 'https://example.com/2.png', prompt: 'p2' },
      ],
      scene: { env: 'room' },
      characters: { characters: [] },
    })
    mockGetDirectorPipelineService.mockResolvedValue({
      execute: mockExecute,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('不会因历史保存挂起而阻塞主生成流程完成', async () => {
    const pendingHistoryPromise = new Promise<void>(() => {})
    const addToHistory = vi.fn(() => pendingHistoryPromise)
    ;(window as any).historyDataServiceTS = { addToHistory }

    const onDone = vi.fn()
    const onError = vi.fn()

    render(<TestHarness onDone={onDone} onError={onError} />)
    fireEvent.click(screen.getByRole('button', { name: 'start' }))

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1)
    })

    expect(onError).not.toHaveBeenCalled()
    expect(addToHistory).toHaveBeenCalledTimes(1)
    expect(useDirectorStore.getState().isGenerating).toBe(false)
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        skipVerify: true,
        scoreThreshold: 8,
      }),
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
