import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useDirectorGeneration } from '../useDirectorGeneration'
import { useDirectorStore } from '../../stores/useDirectorStore'

/**
 * v4.2.7 — Director generation queue regression tests.
 *
 * The hook now exposes `enqueueGeneration()` which always appends a frozen
 * snapshot of the current store to a FIFO queue and kicks `processQueue` in
 * fire-and-forget fashion. These tests guard the five hardest invariants:
 *
 *  1. Jobs are consumed serially (pendingCount goes up then down per job, results accumulate).
 *  2. Pausing the running job blocks the drain loop until resume.
 *  3. cancelGeneration only kills the current job, leaving queued jobs intact.
 *  4. jobId returned from enqueueGeneration() is monotonically increasing.
 *  5. canGenerate stays true during a run so users can stack new jobs.
 */

/** Tiny helper: a promise we can resolve from the outside.
 *  Lets a test precisely control when a mocked pipeline.execute call finishes. */
function createDeferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const executeMock = vi.fn()
const resumeMock = vi.fn()
const requestPauseMock = vi.fn()
const clearPauseRequestMock = vi.fn()

vi.mock('@/services/ServiceBridge', () => ({
  getDirectorPipelineService: vi.fn(async () => ({
    execute: executeMock,
    resume: resumeMock,
    requestPause: requestPauseMock,
    clearPauseRequest: clearPauseRequestMock,
  })),
}))

function makeResult(extra: Record<string, unknown> = {}) {
  return {
    images: [],
    prompts: [],
    panels: [],
    scene: null,
    characters: null,
    report: null,
    ...extra,
  }
}

describe('useDirectorGeneration queue (v4.2.7)', () => {
  beforeEach(() => {
    executeMock.mockReset()
    resumeMock.mockReset()
    requestPauseMock.mockReset()
    clearPauseRequestMock.mockReset()

    window.localStorage.clear()
    window.localStorage.setItem('current_model', 'gemini-3.1-flash-image')

    const store = useDirectorStore.getState()
    store.reset()
    store.setVisionModel('gemini-3-flash-preview')
    store.addReferenceImage({ data: 'test-ref', mimeType: 'image/jpeg', name: 'ref.jpg' })
  })

  it('consumes the queue serially: pendingCount drops as jobs run and results accumulate', async () => {
    const d1 = createDeferred<ReturnType<typeof makeResult>>()
    const d2 = createDeferred<ReturnType<typeof makeResult>>()
    executeMock
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise)

    const { result } = renderHook(() => useDirectorGeneration())

    // Enqueue two jobs back-to-back. processQueue runs synchronously up to
    // its first await, so by the time both enqueues return: job #1 has been
    // shifted off the queue (decrementing pendingCount), job #2 is still
    // waiting. Net pendingCount = 1.
    act(() => {
      void result.current.enqueueGeneration()
      void result.current.enqueueGeneration()
    })
    expect(useDirectorStore.getState().pendingCount).toBe(1)

    // Wait for the drainer to actually invoke pipeline.execute on job #1.
    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1))
    expect(useDirectorStore.getState().pendingCount).toBe(1)

    // Finish job #1 with one image. Drainer should then start job #2,
    // which decrements pendingCount to 0.
    await act(async () => {
      d1.resolve(makeResult({ images: [{ url: 'a.png', prompt: 'a' }] }))
    })
    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(useDirectorStore.getState().pendingCount).toBe(0))

    // Finish job #2 with another image. Both should end up in generatedResults.
    await act(async () => {
      d2.resolve(makeResult({ images: [{ url: 'b.png', prompt: 'b' }] }))
    })
    await waitFor(() => {
      const urls = useDirectorStore.getState().generatedResults.map((r) => r.url)
      expect(urls).toEqual(['a.png', 'b.png'])
    })
  })

  it('does NOT start the next queued job while the current one is paused', async () => {
    const d1 = createDeferred<ReturnType<typeof makeResult>>()
    executeMock.mockReturnValueOnce(d1.promise)

    const { result } = renderHook(() => useDirectorGeneration())

    act(() => {
      void result.current.enqueueGeneration()
      void result.current.enqueueGeneration()
    })
    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1))

    // Resolve job #1 with __paused so the drainer stops draining.
    await act(async () => {
      d1.resolve(makeResult({ __paused: true } as Record<string, unknown>))
    })
    await waitFor(() => expect(useDirectorStore.getState().generationStatus).toBe('paused'))

    // Critical assertion: job #2 must NOT have been picked up.
    expect(executeMock).toHaveBeenCalledTimes(1)
    expect(useDirectorStore.getState().pendingCount).toBe(1)
  })

  it('cancelGeneration aborts the current job but leaves queued jobs untouched', async () => {
    const d1 = createDeferred<ReturnType<typeof makeResult>>()
    const d2 = createDeferred<ReturnType<typeof makeResult>>()
    executeMock
      .mockImplementationOnce((_input, _onProgress, options) => {
        // Simulate a long-running pipeline that rejects with AbortError when
        // the signal fires. Matches what the real pipeline does.
        options?.signal?.addEventListener('abort', () => {
          d1.reject(new DOMException('aborted', 'AbortError'))
        })
        return d1.promise
      })
      .mockReturnValueOnce(d2.promise)

    const { result } = renderHook(() => useDirectorGeneration())

    act(() => {
      void result.current.enqueueGeneration()
      void result.current.enqueueGeneration()
    })
    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1))
    expect(useDirectorStore.getState().pendingCount).toBe(1)

    // Cancel the running job. Drainer should pick up the next one.
    await act(async () => {
      result.current.cancelGeneration()
    })
    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(2))

    // Finish the queued job cleanly; nothing in flight.
    await act(async () => {
      d2.resolve(makeResult())
    })
    await waitFor(() => expect(useDirectorStore.getState().pendingCount).toBe(0))
  })

  it('enqueueGeneration returns a monotonically increasing job id', async () => {
    const d1 = createDeferred<ReturnType<typeof makeResult>>()
    const d2 = createDeferred<ReturnType<typeof makeResult>>()
    const d3 = createDeferred<ReturnType<typeof makeResult>>()
    executeMock
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise)
      .mockReturnValueOnce(d3.promise)

    const { result } = renderHook(() => useDirectorGeneration())

    let ids: number[] = []
    act(() => {
      ids = [
        result.current.enqueueGeneration(),
        result.current.enqueueGeneration(),
        result.current.enqueueGeneration(),
      ]
    })
    expect(ids[0]).toBeLessThan(ids[1])
    expect(ids[1]).toBeLessThan(ids[2])

    // Cleanup: resolve everything so finalizers run.
    await act(async () => {
      d1.resolve(makeResult())
      d2.resolve(makeResult())
      d3.resolve(makeResult())
    })
    await waitFor(() => expect(useDirectorStore.getState().pendingCount).toBe(0))
  })

  it('keeps canGenerate=true while generating, allowing new jobs to be stacked into the live queue', async () => {
    const d1 = createDeferred<ReturnType<typeof makeResult>>()
    executeMock.mockReturnValueOnce(d1.promise)

    const { result } = renderHook(() => useDirectorGeneration())

    act(() => {
      void result.current.enqueueGeneration()
    })
    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1))

    // Mid-flight assertions: still busy, still allowed to enqueue.
    expect(useDirectorStore.getState().generationStatus).toBe('running')
    expect(result.current.canGenerate).toBe(true)

    await act(async () => {
      d1.resolve(makeResult())
    })
    await waitFor(() => expect(useDirectorStore.getState().pendingCount).toBe(0))
  })
})
