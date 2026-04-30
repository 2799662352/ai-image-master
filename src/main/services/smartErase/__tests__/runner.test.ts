// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const uploadStreamMock = vi.fn<(opts: any) => Promise<void>>()
const getPresignedUrlMock = vi.fn<(opts: any) => Promise<string>>()
const cancelUploadMock = vi.fn<(taskId: string) => void>()

const processMediaMock = vi.fn<(req: any) => Promise<any>>()
const describeTaskDetailMock = vi.fn<(req: any) => Promise<any>>()

vi.mock('../../tencent/cosClient', () => ({
  uploadStream: uploadStreamMock,
  getPresignedUrl: getPresignedUrlMock,
  cancelUpload: cancelUploadMock,
}))

vi.mock('../../tencent/mpsClient', () => ({
  getMpsClient: () => ({
    ProcessMedia: processMediaMock,
    DescribeTaskDetail: describeTaskDetailMock,
  }),
}))

vi.mock('../../tencent/credentials', () => ({
  getCredentials: () => ({
    secretId: 'id',
    secretKey: 'k',
    bucket: 'demo-1300000000',
    region: 'ap-shanghai',
  }),
}))

function freshJob(overrides: Record<string, any> = {}) {
  return {
    taskId: 'task-abc',
    filePath: '/local/videos/clip.mp4',
    filename: 'clip.mp4',
    durationSeconds: 30,
    posterDataUrl: 'data:image/jpeg;base64,POSTER',
    config: { mode: 'definition' as const, definitionId: 303, autoCleanupRemoteAfterDays: 7 },
    ...overrides,
  }
}

function buildFinishSuccess(outputPath = '/smart-erase/abc/output.mp4') {
  return {
    Status: 'FINISH',
    WorkflowTask: {
      ErrCode: 0,
      SmartEraseTaskResult: {
        Status: 'SUCCESS',
        Output: { Path: outputPath },
      },
    },
  }
}

describe('smartErase/runner.runEraseJob', () => {
  beforeEach(() => {
    vi.resetModules()
    uploadStreamMock.mockReset()
    getPresignedUrlMock.mockReset()
    cancelUploadMock.mockReset()
    processMediaMock.mockReset()
    describeTaskDetailMock.mockReset()

    uploadStreamMock.mockResolvedValue(undefined)
    getPresignedUrlMock.mockResolvedValue('https://cos.example/presigned')
    processMediaMock.mockResolvedValue({ TaskId: 'mps-task-1' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Test 1: happy path uploads, submits ProcessMedia with SmartEraseTask at TOP LEVEL, polls, returns presigned URL', async () => {
    vi.useFakeTimers()
    let polls = 0
    describeTaskDetailMock.mockImplementation(() => {
      polls++
      if (polls === 1) return Promise.resolve({ Status: 'PROCESSING' })
      return Promise.resolve(buildFinishSuccess('/smart-erase/abc/output.mp4'))
    })

    const { runEraseJob } = await import('../runner')
    const ctrl = new AbortController()
    const job = freshJob()
    const promise = runEraseJob(job, ctrl.signal)

    await vi.advanceTimersByTimeAsync(6_000) // 5s wait between poll 1 and 2

    const result = await promise

    // upload
    expect(uploadStreamMock).toHaveBeenCalledTimes(1)
    expect(uploadStreamMock.mock.calls[0][0]).toMatchObject({
      key: 'smart-erase/task-abc/input/clip.mp4',
      filePath: '/local/videos/clip.mp4',
    })

    // submit
    expect(processMediaMock).toHaveBeenCalledTimes(1)
    const submitArg = processMediaMock.mock.calls[0][0]
    expect(submitArg.InputInfo).toEqual({
      Type: 'COS',
      CosInputInfo: { Bucket: 'demo-1300000000', Region: 'ap-shanghai', Object: '/smart-erase/task-abc/input/clip.mp4' },
    })
    expect(submitArg.OutputStorage).toEqual({
      Type: 'COS',
      CosOutputStorage: { Bucket: 'demo-1300000000', Region: 'ap-shanghai' },
    })
    expect(submitArg.OutputDir).toBe('/smart-erase/task-abc/output/')
    // CRITICAL: SmartEraseTask is TOP-LEVEL on the request, single object, NOT nested in MediaProcessTask, NOT a *Set array.
    expect(submitArg.SmartEraseTask).toEqual({ Definition: 303 })
    expect('MediaProcessTask' in submitArg).toBe(false)

    // poll resolved + presigned
    expect(describeTaskDetailMock).toHaveBeenCalledTimes(2)
    expect(describeTaskDetailMock.mock.calls[0][0]).toEqual({ TaskId: 'mps-task-1' })
    expect(getPresignedUrlMock).toHaveBeenCalledWith({
      key: 'smart-erase/abc/output.mp4',
      expireSeconds: 7 * 86400,
    })

    expect(result).toMatchObject({
      videoUrl: 'https://cos.example/presigned',
      outputCosKey: 'smart-erase/abc/output.mp4',
      inputCosKey: 'smart-erase/task-abc/input/clip.mp4',
      posterDataUrl: 'data:image/jpeg;base64,POSTER',
      mpsTaskId: 'mps-task-1',
    })
    expect(result.videoExpiresAt).toBeGreaterThan(Date.now())
  })

  it('Test 2: leading-slash on Output.Path is stripped from outputCosKey', async () => {
    describeTaskDetailMock.mockResolvedValueOnce(buildFinishSuccess('/smart-erase/abc/output.mp4'))

    const { runEraseJob } = await import('../runner')
    const result = await runEraseJob(freshJob(), new AbortController().signal)
    expect(result.outputCosKey).toBe('smart-erase/abc/output.mp4')
    expect(result.outputCosKey.startsWith('/')).toBe(false)
  })

  it('Test 3: SmartEraseTaskResult.Status === FAIL throws MPS_TASK_FAILED with ErrCodeExt + Message', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        SmartEraseTaskResult: { Status: 'FAIL', ErrCodeExt: 'X', Message: 'msg' },
      },
    })

    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'MPS_TASK_FAILED',
      message: expect.stringContaining('X: msg'),
    })
  })

  it('Test 4: WorkflowTask.ErrCode != 0 throws MPS_SOURCE_ERROR (and check happens BEFORE SmartEraseTaskResult lookup)', async () => {
    // No SmartEraseTaskResult here — ErrCode check must run first; otherwise we'd OUTPUT_NOT_FOUND instead.
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: { ErrCode: 1234, Message: 'source corrupt' },
    })

    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'MPS_SOURCE_ERROR',
      message: expect.stringContaining('1234: source corrupt'),
    })
  })

  it('Test 5: Status === FINISH but WorkflowTask missing → OUTPUT_NOT_FOUND', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({ Status: 'FINISH' })
    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'OUTPUT_NOT_FOUND',
    })
  })

  it('Test 6: ErrCode == 0 + SmartEraseTaskResult missing → OUTPUT_NOT_FOUND', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: { ErrCode: 0 }, // no SmartEraseTaskResult
    })
    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'OUTPUT_NOT_FOUND',
    })
  })

  it('Test 7: SUCCESS but Output.Path empty string → OUTPUT_NOT_FOUND', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        SmartEraseTaskResult: { Status: 'SUCCESS', Output: { Path: '' } },
      },
    })
    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'OUTPUT_NOT_FOUND',
    })
  })

  it('Test 8: SUCCESS but Output undefined → OUTPUT_NOT_FOUND', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        SmartEraseTaskResult: { Status: 'SUCCESS' /* no Output */ },
      },
    })
    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'OUTPUT_NOT_FOUND',
    })
  })

  it('Test 9: top-level Status === WAITING continues polling (does not throw)', async () => {
    vi.useFakeTimers()
    let polls = 0
    describeTaskDetailMock.mockImplementation(() => {
      polls++
      if (polls === 1) return Promise.resolve({ Status: 'WAITING' })
      return Promise.resolve(buildFinishSuccess())
    })

    const { runEraseJob } = await import('../runner')
    const promise = runEraseJob(freshJob(), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(6_000)
    await promise // resolves without throwing
    expect(describeTaskDetailMock).toHaveBeenCalledTimes(2)
  })

  it('Test 10: SmartEraseTaskResult.Status === PROCESSING continues even when Status === FINISH', async () => {
    vi.useFakeTimers()
    let polls = 0
    describeTaskDetailMock.mockImplementation(() => {
      polls++
      if (polls === 1) {
        return Promise.resolve({
          Status: 'FINISH',
          WorkflowTask: { ErrCode: 0, SmartEraseTaskResult: { Status: 'PROCESSING' } },
        })
      }
      return Promise.resolve(buildFinishSuccess())
    })

    const { runEraseJob } = await import('../runner')
    const promise = runEraseJob(freshJob(), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(6_000)
    await promise
    expect(describeTaskDetailMock).toHaveBeenCalledTimes(2)
  })

  it('Test 11: 90-min source → poll deadline = 90*60*4*1000 ms (≈6h), not 60-min floor', async () => {
    const { calculatePollDeadline } = await import('../runner')
    const now = 1_000_000
    const result = calculatePollDeadline(90 * 60, now)
    expect(result - now).toBe(90 * 60 * 4 * 1000) // 6 hours = 21,600,000 ms
  })

  it('Test 12: 5-min source → poll deadline pinned to 60-min floor (because 5*60*4 = 1200s < 3600s)', async () => {
    const { calculatePollDeadline } = await import('../runner')
    const now = 1_000_000
    const result = calculatePollDeadline(5 * 60, now)
    expect(result - now).toBe(60 * 60 * 1000) // 60-min floor
  })

  it('Test 13: signal.aborted right after upload → throws TASK_CANCELLED BEFORE ProcessMedia is called', async () => {
    const ctrl = new AbortController()
    uploadStreamMock.mockImplementationOnce(async () => {
      ctrl.abort()
    })

    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), ctrl.signal)).rejects.toMatchObject({
      code: 'TASK_CANCELLED',
    })
    expect(processMediaMock).not.toHaveBeenCalled()
  })

  it('Test 14: signal.aborted mid-poll → throws TASK_CANCELLED, no further DescribeTaskDetail calls', async () => {
    vi.useFakeTimers()
    const ctrl = new AbortController()
    let polls = 0
    describeTaskDetailMock.mockImplementation(() => {
      polls++
      if (polls === 1) return Promise.resolve({ Status: 'PROCESSING' })
      throw new Error('Should not be called after abort')
    })

    const { runEraseJob } = await import('../runner')
    const promise = runEraseJob(freshJob(), ctrl.signal)
    promise.catch(() => {})

    // Let poll 1 happen + start the 5s wait
    await vi.advanceTimersByTimeAsync(0)
    // Abort during the wait
    ctrl.abort()
    await vi.advanceTimersByTimeAsync(6_000)

    await expect(promise).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
    expect(describeTaskDetailMock).toHaveBeenCalledTimes(1) // only the first poll
  })

  it('Test 15: ProcessMedia rejects with InvalidParameterValue.Definition → TEMPLATE_NOT_FOUND', async () => {
    const sdkErr: any = new Error('Definition 303 not found')
    sdkErr.code = 'InvalidParameterValue.Definition'
    processMediaMock.mockRejectedValueOnce(sdkErr)

    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    })
  })
})
