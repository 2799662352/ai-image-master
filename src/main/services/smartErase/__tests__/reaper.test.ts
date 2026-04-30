// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const deleteObjectsMock = vi.fn<(keys: string[]) => Promise<void>>()
const describeTaskDetailMock = vi.fn<(req: any) => Promise<any>>()

vi.mock('../../tencent/cosClient', () => ({
  deleteObjects: deleteObjectsMock,
}))

vi.mock('../../tencent/mpsClient', () => ({
  getMpsClient: () => ({ DescribeTaskDetail: describeTaskDetailMock }),
}))

const REAPER_INTERVAL_MS = 5_000

describe('smartErase/reaper', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    deleteObjectsMock.mockReset()
    describeTaskDetailMock.mockReset()
    deleteObjectsMock.mockResolvedValue(undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    warnSpy.mockRestore()
  })

  it('Test 1: FINISH+SUCCESS triggers deleteObjects([inputKey, outputKey]) and removes entry', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        SmartEraseTaskResult: {
          Status: 'SUCCESS',
          Output: { Path: '/smart-erase/abc/output.mp4' },
        },
      },
    })

    const { trackForReaping, getReapingSize, untrackAndCleanupAll } = await import('../reaper')
    trackForReaping('mps-1', 'smart-erase/abc/input/clip.mp4')
    expect(getReapingSize()).toBe(1)

    await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS)
    // microtask: DescribeTaskDetail resolves -> deleteObjects scheduled
    await vi.advanceTimersByTimeAsync(0)

    expect(describeTaskDetailMock).toHaveBeenCalledWith({ TaskId: 'mps-1' })
    expect(deleteObjectsMock).toHaveBeenCalledTimes(1)
    expect(deleteObjectsMock).toHaveBeenCalledWith(
      expect.arrayContaining(['smart-erase/abc/input/clip.mp4', 'smart-erase/abc/output.mp4']),
    )
    expect(deleteObjectsMock.mock.calls[0][0]).toHaveLength(2)
    expect(getReapingSize()).toBe(0)
    await untrackAndCleanupAll()
  })

  it('Test 2: FINISH+FAIL triggers deleteObjects with [inputKey] only (no output produced)', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        SmartEraseTaskResult: { Status: 'FAIL', ErrCodeExt: 'X', Message: 'failed' },
      },
    })

    const { trackForReaping, getReapingSize, untrackAndCleanupAll } = await import('../reaper')
    trackForReaping('mps-2', 'smart-erase/xyz/input/bad.mp4')
    await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(0)

    expect(deleteObjectsMock).toHaveBeenCalledTimes(1)
    expect(deleteObjectsMock).toHaveBeenCalledWith(['smart-erase/xyz/input/bad.mp4'])
    expect(getReapingSize()).toBe(0)
    await untrackAndCleanupAll()
  })

  it('Test 3: PROCESSING (outer or inner) keeps entry, no delete call', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({ Status: 'PROCESSING' })

    const { trackForReaping, getReapingSize, untrackAndCleanupAll } = await import('../reaper')
    trackForReaping('mps-3', 'smart-erase/proc/input/clip.mp4')

    await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(0)

    expect(deleteObjectsMock).not.toHaveBeenCalled()
    expect(getReapingSize()).toBe(1)
    await untrackAndCleanupAll()
  })

  it('Test 4: deleteObjects rejects → entry STILL removed, warning logged, reaper does not crash', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        SmartEraseTaskResult: { Status: 'SUCCESS', Output: { Path: '/smart-erase/del/output.mp4' } },
      },
    })
    deleteObjectsMock.mockRejectedValueOnce(new Error('COS network error'))

    const { trackForReaping, getReapingSize, untrackAndCleanupAll } = await import('../reaper')
    trackForReaping('mps-4', 'smart-erase/del/input/clip.mp4')

    await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS)
    // Wait for the rejected delete to surface and entry-removal to run
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(deleteObjectsMock).toHaveBeenCalledTimes(1)
    expect(getReapingSize()).toBe(0) // entry removed despite delete failure
    expect(warnSpy).toHaveBeenCalled()
    const warnMessages = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(warnMessages).toContain('COS network error')
    await untrackAndCleanupAll()
  })

  it('Test 5: untrackAndCleanupAll clears map and stops interval (no further DescribeTaskDetail)', async () => {
    describeTaskDetailMock.mockResolvedValue({ Status: 'PROCESSING' })

    const { trackForReaping, getReapingSize, untrackAndCleanupAll } = await import('../reaper')
    trackForReaping('mps-5a', 'smart-erase/a/input/clip.mp4')
    trackForReaping('mps-5b', 'smart-erase/b/input/clip.mp4')
    expect(getReapingSize()).toBe(2)

    // First tick: 2 polls, both still PROCESSING
    await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(describeTaskDetailMock).toHaveBeenCalledTimes(2)

    await untrackAndCleanupAll()
    expect(getReapingSize()).toBe(0)

    // Advance several intervals — interval should be cleared
    await vi.advanceTimersByTimeAsync(REAPER_INTERVAL_MS * 5)
    await vi.advanceTimersByTimeAsync(0)

    expect(describeTaskDetailMock).toHaveBeenCalledTimes(2) // unchanged
  })
})
