// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const runUploadMock = vi.fn()
const runProcessAndPollMock = vi.fn()
const trackForReapingMock = vi.fn()
const deleteObjectsMock = vi.fn()
const transferUrlToHistoryBucketMock = vi.fn()
const getCredentialsMock = vi.fn(() => ({
  secretId: 'sid',
  secretKey: 'sk',
  bucket: 'b-1',
  region: 'ap-shanghai',
}))
const getCredentialStateMock = vi.fn(() => ({ hasCredentials: true }))
const setCredentialsMock = vi.fn()

vi.mock('../runner', () => ({
  runUpload: runUploadMock,
  runProcessAndPoll: runProcessAndPollMock,
}))

vi.mock('../reaper', () => ({
  trackForReaping: trackForReapingMock,
}))

vi.mock('../../tencent/cosClient', () => ({
  deleteObjects: deleteObjectsMock,
}))

vi.mock('../../tencent/historyBucketTransfer', () => ({
  transferUrlToHistoryBucket: transferUrlToHistoryBucketMock,
}))

vi.mock('../../tencent/credentials', () => ({
  getCredentials: getCredentialsMock,
  getCredentialState: getCredentialStateMock,
  setCredentials: setCredentialsMock,
}))

// Window stub
const sendSpy = vi.fn()
const mockWin = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: sendSpy,
  },
}

const SUBMIT_PAYLOAD = {
  filePath: '/tmp/test.mp4',
  filename: 'test.mp4',
  fileSize: 1024,
  durationSeconds: 30,
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('smartErase service composer', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    runUploadMock.mockReset()
    runProcessAndPollMock.mockReset()
    trackForReapingMock.mockReset()
    deleteObjectsMock.mockReset()
    transferUrlToHistoryBucketMock.mockReset()
    sendSpy.mockClear()

    runUploadMock.mockResolvedValue({ inputCosKey: 'smart-erase/x/input/test.mp4' })
    runProcessAndPollMock.mockResolvedValue({
      videoUrl: 'https://cos.example/output.mp4?sig=abc',
      videoExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      outputCosKey: 'smart-erase/x/output/done.mp4',
      mpsTaskId: 'mps-123',
    })
    transferUrlToHistoryBucketMock.mockResolvedValue(
      'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/smart-erase/x.mp4',
    )

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('Test 1: submitErase invokes runner and reports activeCount', async () => {
    // runUpload pauses long enough for us to observe an active task.
    let resolveUpload: (v: any) => void = () => {}
    runUploadMock.mockReturnValueOnce(new Promise((r) => { resolveUpload = r }))

    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)

    const ret = await svc.submitErase(SUBMIT_PAYLOAD)
    expect(ret.success).toBe(true)
    expect(ret.taskId).toBeDefined()

    // Active task is sitting in the upload queue, runUpload pending
    expect(svc.getActiveCount()).toBe(1)
    expect(runUploadMock).toHaveBeenCalledTimes(1)
    const [uploadArg, signalArg] = runUploadMock.mock.calls[0]
    expect(uploadArg.filePath).toBe('/tmp/test.mp4')
    expect(uploadArg.filename).toBe('test.mp4')
    expect(uploadArg.taskId).toBe(ret.taskId)
    expect(signalArg).toBeInstanceOf(AbortSignal)

    // Cleanup so the test doesn't leak an unresolved promise
    resolveUpload({ inputCosKey: 'smart-erase/x/input/test.mp4' })
    await flush()
    await flush()
  })

  it('Test 2: cancel during processing → reaper.trackForReaping called, status=cancelled emitted', async () => {
    // Make the process phase emit mpsTaskId then hang until aborted.
    runProcessAndPollMock.mockImplementationOnce(async (_job, signal, events) => {
      events?.onProgress?.({ stage: 'processing', mpsTaskId: 'mps-cancel-test' })
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('Cancelled'), { code: 'TASK_CANCELLED', stage: 'poll' }))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort)
      })
      throw new Error('unreachable')
    })

    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)

    const ret = await svc.submitErase(SUBMIT_PAYLOAD)
    const taskId = ret.taskId!

    // Let upload finish, processQueue picks up, runProcessAndPollMock fires onProgress
    await flush()
    await flush()
    await flush()

    // mpsTaskId should now be tracked
    const progressCalls = sendSpy.mock.calls.filter((c) => c[0] === 'erase:progress')
    expect(progressCalls.some((c) => c[1].mpsTaskId === 'mps-cancel-test')).toBe(true)

    // Cancel — should hit processing phase, route to reaper
    svc.cancelEraseTask(taskId)
    await flush()
    await flush()

    expect(trackForReapingMock).toHaveBeenCalledWith(
      'mps-cancel-test',
      'smart-erase/x/input/test.mp4',
    )

    const cancelledEvent = sendSpy.mock.calls
      .filter((c) => c[0] === 'erase:progress')
      .find((c) => c[1].status === 'cancelled')
    expect(cancelledEvent).toBeDefined()
    expect(cancelledEvent![1].taskId).toBe(taskId)
  })

  it('Test 3: cancelAllActiveSmartEraseTasks aborts all tasks; does NOT clear reaper', async () => {
    runUploadMock.mockImplementation(() => new Promise(() => { /* hang forever */ }))

    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)

    await svc.submitErase({ ...SUBMIT_PAYLOAD, filename: 'a.mp4' })
    await svc.submitErase({ ...SUBMIT_PAYLOAD, filename: 'b.mp4' })
    await svc.submitErase({ ...SUBMIT_PAYLOAD, filename: 'c.mp4' })
    expect(svc.getActiveCount()).toBe(3)

    svc.cancelAllActiveSmartEraseTasks()
    await flush()
    await flush()

    expect(svc.getActiveCount()).toBe(0)
    // Reaper is NOT touched by cancelAll — only by individual cancels during processing
    // (these tasks are in upload phase, no MPS submitted yet, so trackForReaping should NOT fire)
    expect(trackForReapingMock).not.toHaveBeenCalled()
  })

  it('Test 4: 完成后转存历史桶 → erase:finished 带永久 URL 且 videoExpiresAt=0', async () => {
    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)

    const ret = await svc.submitErase(SUBMIT_PAYLOAD)
    // upload → process → transfer 三段都是 microtask/immediate 链
    await flush(); await flush(); await flush(); await flush()

    expect(transferUrlToHistoryBucketMock).toHaveBeenCalledWith({
      sourceUrl: 'https://cos.example/output.mp4?sig=abc',
      key: `image-history/smart-erase/${ret.taskId}.mp4`,
      contentType: 'video/mp4',
    })

    const finished = sendSpy.mock.calls.find((c) => c[0] === 'erase:finished')
    expect(finished).toBeDefined()
    expect(finished![1].videoUrl).toBe(
      'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/smart-erase/x.mp4',
    )
    expect(finished![1].videoExpiresAt).toBe(0)
  })

  it('Test 5: 转存失败不影响任务成功 → 退回签名 URL + 原过期时间', async () => {
    transferUrlToHistoryBucketMock.mockRejectedValueOnce(new Error('bucket down'))

    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)

    await svc.submitErase(SUBMIT_PAYLOAD)
    await flush(); await flush(); await flush(); await flush()

    const finished = sendSpy.mock.calls.find((c) => c[0] === 'erase:finished')
    expect(finished).toBeDefined()
    expect(finished![1].videoUrl).toBe('https://cos.example/output.mp4?sig=abc')
    expect(finished![1].videoExpiresAt).toBeGreaterThan(0)
  })

})
